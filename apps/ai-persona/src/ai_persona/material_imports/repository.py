from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from .models import ImportDraft


class ImportDraftError(ValueError):
    """Raised when a material import draft is missing, expired, or invalid."""


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )


class ImportDraftRepository:
    def __init__(self, state_root: Path) -> None:
        self.root = state_root.resolve() / "material-imports"

    @staticmethod
    def _validate_id(draft_id: str) -> None:
        if not draft_id.startswith("imp_") or any(
            character in draft_id for character in "/\\\0"
        ):
            raise ImportDraftError("无效的材料导入草稿 ID")

    def create(self, draft: ImportDraft, files: dict[str, bytes]) -> ImportDraft:
        self._validate_id(draft.id)
        declared = {item.path: item.sha256 for item in draft.files}
        if set(files) != set(declared):
            raise ImportDraftError("材料导入草稿的文件清单不一致")
        for path, content in files.items():
            if hashlib.sha256(content).hexdigest() != declared[path]:
                raise ImportDraftError(f"材料导入草稿文件 Hash 不一致：{path}")

        self.root.mkdir(parents=True, exist_ok=True)
        destination = self.root / draft.id
        if destination.exists():
            raise ImportDraftError("材料导入草稿已经存在")
        temporary = Path(tempfile.mkdtemp(prefix=f".{draft.id}-", dir=self.root))
        try:
            for relative_path, content in files.items():
                target = temporary / relative_path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            (temporary / "draft.json").write_bytes(
                _json_bytes(draft.model_dump(mode="json", by_alias=True))
            )
            temporary.replace(destination)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        return self.get(draft.id)

    def get(self, draft_id: str) -> ImportDraft:
        self._validate_id(draft_id)
        path = self.root / draft_id / "draft.json"
        if not path.is_file():
            raise ImportDraftError("材料导入草稿不存在或已经被清理")
        try:
            draft = ImportDraft.model_validate_json(path.read_text(encoding="utf-8"))
        except (OSError, ValidationError, ValueError) as exc:
            raise ImportDraftError("材料导入草稿无效") from exc
        now = datetime.now(timezone.utc)
        if draft.expires_at <= now and not self.has_editor(draft_id):
            self.delete(draft_id)
            raise ImportDraftError("材料导入草稿已经过期，请重新识别材料")
        for item in draft.files:
            file_path = self.file_path(draft, item.path)
            if hashlib.sha256(file_path.read_bytes()).hexdigest() != item.sha256:
                raise ImportDraftError(f"材料导入草稿文件已变化：{item.path}")
        return draft

    def has_editor(self, draft_id: str) -> bool:
        """Keep uploaded sources while a durable, unfinished editor refers to them."""
        path = self.root.parent / "editor-drafts.sqlite3"
        if not path.is_file():
            return False
        with closing(sqlite3.connect(path)) as db:
            return db.execute(
                "SELECT 1 FROM drafts WHERE closed=0 AND (page=? OR page LIKE ?) LIMIT 1",
                (f"/materials/imports/{draft_id}", f"/materials/imports/{draft_id}?%"),
            ).fetchone() is not None

    def file_path(self, draft: ImportDraft, relative_path: str) -> Path:
        declared = {item.path for item in draft.files}
        if relative_path not in declared:
            raise ImportDraftError("材料导入草稿引用了未声明文件")
        draft_root = (self.root / draft.id).resolve()
        path = (draft_root / relative_path).resolve()
        try:
            path.relative_to(draft_root)
        except ValueError as exc:
            raise ImportDraftError("材料导入草稿文件越过目录边界") from exc
        if not path.is_file():
            raise ImportDraftError("材料导入草稿文件不存在")
        return path

    def delete(self, draft_id: str) -> None:
        self._validate_id(draft_id)
        shutil.rmtree(self.root / draft_id, ignore_errors=True)

    def cleanup_expired(self) -> int:
        if not self.root.is_dir():
            return 0
        now = datetime.now(timezone.utc)
        removed = 0
        for path in self.root.iterdir():
            if not path.is_dir() or not path.name.startswith("imp_"):
                continue
            draft_path = path / "draft.json"
            try:
                draft = ImportDraft.model_validate_json(
                    draft_path.read_text(encoding="utf-8")
                )
            except (OSError, ValidationError, ValueError):
                continue
            if draft.expires_at <= now and not self.has_editor(draft.id):
                shutil.rmtree(path, ignore_errors=True)
                removed += 1
        return removed

    def save(self, draft: ImportDraft) -> None:
        self._validate_id(draft.id)
        path = self.root / draft.id / "draft.json"
        if not path.is_file():
            raise ImportDraftError("材料导入草稿不存在")
        content = _json_bytes(draft.model_dump(mode="json", by_alias=True))
        descriptor, temporary_name = tempfile.mkstemp(prefix=".draft-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_name, path)
        finally:
            Path(temporary_name).unlink(missing_ok=True)
