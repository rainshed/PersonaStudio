"""Human-authored private research notes, with canonical Markdown and full revisions.

The canonical file is the commit point: a revision is visible only up to that file's
revision. Snapshot-first publication therefore survives interrupted writes without
publishing half an ending. Idea changes do not change the public Persona revision.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import tempfile
import tomllib
import uuid
from contextlib import nullcontext
from datetime import datetime, timezone
from pathlib import Path

import yaml
from pydantic import ValidationError

from .agent import AgentServiceError
from .change_sets import proposal_lock
from .compiler import _atomic_write
from .frontmatter import dump_markdown_record, load_markdown_record
from .idea_links import apply_links
from .models import Idea, IdeaResource, SourceManifest
from .store import LoadedRecord, PersonaStore, StoreValidationError

LABELS = {
    "execution_status": {"not_started": "未开始执行", "in_progress": "执行中", "ended": "已结束"},
    "novelty": {"unknown": "尚未判断", "novel": "新颖", "incremental": "增量改进", "non_novel": "不新颖"},
    "difficulty": {"unknown": "尚未判断", "low": "低", "medium": "中", "high": "高"},
    "outcome": {"success": "成功完成", "partial": "部分完成", "abandoned": "放弃"},
}
EN_LABELS = {
    "execution_status": {"not_started": "Not started", "in_progress": "In progress", "ended": "Ended"},
    "novelty": {"unknown": "Not assessed", "novel": "Novel", "incremental": "Incremental", "non_novel": "Not novel"},
    "difficulty": {"unknown": "Not assessed", "low": "Low", "medium": "Medium", "high": "High"},
    "outcome": {"success": "Completed", "partial": "Partially completed", "abandoned": "Abandoned"},
}
FIELDS = {"title", "body", "novelty", "novelty_reason", "difficulty", "difficulty_reason",
          "execution_status", "closure", "resources", "status", "related_refs", "project"}


def payload(loaded: LoadedRecord) -> dict:
    return {**loaded.record.model_dump(mode="json", by_alias=True), "body": loaded.body}


def sync_directory(path: Path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class IdeaService:
    def __init__(self, data_root: Path, state_root: Path):
        self.data = data_root.resolve()
        self.state = state_root.resolve()

    def store(self):
        return PersonaStore(self.data).load(verify_source_files=False)

    def upload_limit(self):
        config = tomllib.loads((self.data / "config/persona.toml").read_text())
        limit = config.get("ideas", {}).get("max_upload_mb", 20)
        if type(limit) is not int or not 1 <= limit <= 50:
            raise AgentServiceError("invalid_config", "Ideas 文件大小限制应为 1–50 MB。")
        return limit * 1024 * 1024

    @staticmethod
    def identifier(identifier):
        if not re.fullmatch(r"idea_[a-zA-Z0-9_-]{1,100}", identifier):
            raise AgentServiceError("not_found", "找不到这个想法。")
        return identifier

    def get(self, identifier, store=None):
        self.identifier(identifier)
        loaded = (store or self.store()).records.get(identifier)
        if not loaded or not isinstance(loaded.record, Idea):
            raise AgentServiceError("not_found", "找不到这个想法。")
        return loaded

    def save(self, identifier, expected_revision, values, origin="http://127.0.0.1:8765", *, _locked=False):
        self.identifier(identifier)
        if type(expected_revision) is not int or expected_revision < 0:
            raise AgentServiceError("invalid_request", "保存需要当前版本号。")
        if not isinstance(values, dict) or set(values) - FIELDS:
            raise AgentServiceError("invalid_request", "存在不支持的想法字段。")
        with nullcontext() if _locked else proposal_lock(self.state):
            store = self.store()
            old = store.records.get(identifier)
            if old and not isinstance(old.record, Idea):
                raise AgentServiceError("not_found", "找不到这个想法。")
            if (old.record.revision if old else 0) != expected_revision:
                raise AgentServiceError("conflict", "记录已在别处更新。输入已保留，请查看最新记录后再合并修改。")
            now = datetime.now(timezone.utc)
            data = old.record.model_dump(mode="json", by_alias=True) if old else {
                "schema": "ai-persona.idea/v1", "entity_type": "idea", "id": identifier,
                "revision": 1, "status": "active", "created_at": now, "updated_at": now,
            }
            body = values.get("body", old.body if old else "")
            if not isinstance(body, str) or len(body.encode()) > 800_000:
                raise AgentServiceError("invalid_request", "正文过大或格式无效。")
            body = body.replace("\r\n", "\n").replace("\r", "\n").strip()
            data.update({k: v for k, v in values.items() if k not in {"body", "related_refs", "project"}})
            if "related_refs" in values or "project" in values:
                apply_links(data, values, store, origin, old.record.resources if old else ())
            # Reopening always clears the CURRENT result; historical snapshots are untouched.
            if old and old.record.execution_status == "ended" and data["execution_status"] != "ended":
                data["closure"] = None
            try:
                record = Idea.model_validate(data)
            except ValidationError as exc:
                raise AgentServiceError("invalid_request", "请填写标题；已结束的想法必须选择结果并填写简要说明。") from exc
            path = old.path if old else self.data / "records/ideas" / f"{identifier}.md"
            candidate = LoadedRecord(record, body, path)
            store.records[identifier] = candidate
            try:
                store.validate(verify_source_files=False)
            except StoreValidationError as exc:
                raise AgentServiceError("invalid_resource", "资源引用无效，请重新选择已保存的文件。") from exc
            if old and payload(candidate) == payload(old):
                return {"item": payload(old), "changed": False}
            record = record.model_copy(update={"revision": expected_revision + 1, "updated_at": now})
            candidate = LoadedRecord(record, body, path)
            content = dump_markdown_record(record.model_dump(mode="json", by_alias=True), body).encode()
            history = self.data / "revisions/ideas" / identifier
            history.mkdir(parents=True, exist_ok=True)
            # If a hand-authored canonical record has no snapshot yet, preserve it first.
            if old:
                baseline = history / f"{old.record.revision:08d}.md"
                if not baseline.exists():
                    _atomic_write(baseline, old.path.read_bytes())
            snapshot = history / f"{record.revision:08d}.md"
            try:
                _atomic_write(snapshot, content)
                sync_directory(history)
                _atomic_write(path, content)
                sync_directory(path.parent)
            except Exception:
                # A failure reported after replace must not turn a committed save into a retry.
                if not path.exists() or path.read_bytes() != content:
                    snapshot.unlink(missing_ok=True)
                    raise
            return {"item": payload(candidate), "changed": True}

    def history(self, identifier):
        with proposal_lock(self.state):
            current = self.get(identifier)
            items = []
            for path in sorted((self.data / "revisions/ideas" / identifier).glob("*.md"), reverse=True):
                if not path.stem.isdigit() or int(path.stem) > current.record.revision:
                    continue
                raw, body = load_markdown_record(path)
                record = Idea.model_validate(raw)
                if record.id != identifier or record.revision != int(path.stem):
                    raise AgentServiceError("invalid_history", "历史版本不完整，请检查备份。")
                items.append(payload(LoadedRecord(record, body, path)))
            return items or [payload(current)]

    def upload(self, filename, content, media_type):
        if not content or len(content) > self.upload_limit():
            raise AgentServiceError("input_limit", "文件为空或超过上传大小限制。")
        name = Path(filename.replace("\\", "/")).name
        name = "".join(c for c in name if ord(c) >= 32)[:200] or "attachment"
        suffix = Path(name).suffix[:20]
        relative = "original" + (suffix if re.fullmatch(r"\.[a-zA-Z0-9_-]+", suffix) else "")
        sid = "src_" + uuid.uuid4().hex
        digest = hashlib.sha256(content).hexdigest()
        manifest = SourceManifest.model_validate({
            "schema": "ai-persona.source-manifest/v2", "id": sid,
            "source_type": "idea_attachment", "imported_at": datetime.now(timezone.utc),
            "origin": {"provider": "ideas-upload", "identifier": name},
            "canonical_file": relative, "content_hash": digest,
            "files": [{"path": relative, "role": "original", "sha256": digest,
                       "media_type": media_type or "application/octet-stream"}],
        })
        with proposal_lock(self.state):
            root = self.data / "sources"
            root.mkdir(parents=True, exist_ok=True)
            temporary = Path(tempfile.mkdtemp(prefix=".idea-", dir=root))
            try:
                _atomic_write(temporary / relative, content)
                _atomic_write(temporary / "manifest.yaml", yaml.safe_dump(
                    manifest.model_dump(mode="json", by_alias=True), allow_unicode=True
                ).encode())
                temporary.rename(root / sid)
                sync_directory(root)
            finally:
                if temporary.exists():
                    shutil.rmtree(temporary)
        return IdeaResource(id="res_" + uuid.uuid4().hex, kind="file", title=name,
                            source_ref=sid, file_path=relative).model_dump(mode="json")

    def file(self, source_id, relative):
        store = self.store()
        try:
            path = store.source_file_path(source_id, relative)
            source = store.sources[source_id]
            file = next(f for f in source.files if f.path == relative)
            if hashlib.sha256(path.read_bytes()).hexdigest() != file.sha256:
                raise ValueError("hash mismatch")
        except (StoreValidationError, ValueError, OSError) as exc:
            raise AgentServiceError("missing_file", "文件缺失或已变化，请从备份恢复。想法正文仍可编辑。") from exc
        return path, source.origin.identifier or path.name

    def context(self, identifier, resources=False, locale="zh-CN"):
        loaded = self.get(identifier)
        r = loaded.record
        labels = LABELS if locale == "zh-CN" else EN_LABELS
        lines = [f"# {r.title}", "", f"执行状态 / Status：{labels['execution_status'][r.execution_status]}",
                 f"新颖性 / Novelty：{labels['novelty'][r.novelty]}",
                 f"判断说明 / Reason：{r.novelty_reason or '—'}",
                 f"实现难度 / Difficulty：{labels['difficulty'][r.difficulty]}",
                 f"判断说明 / Reason：{r.difficulty_reason or '—'}"]
        if r.closure:
            lines.extend([f"结束结果 / Outcome：{labels['outcome'][r.closure.outcome]}", r.closure.summary])
        lines.extend(["", loaded.body])
        if resources:
            lines.extend(["", "## 资源 / Resources"])
            lines.extend(f"- {x.title or x.url or x.file_path}：{x.url or x.file_path} {x.note}" for x in r.resources)
        return "\n".join(lines)
