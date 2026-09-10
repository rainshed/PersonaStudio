"""Folder snapshots for preference samples; no agent retrieval behavior."""

from __future__ import annotations

import hashlib
import io
import json
import mimetypes
import shutil
import unicodedata
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import yaml

from .materials import (
    MAX_SOURCE_BYTES,
    MaterialSourceError,
    SourceAttachment,
    StagedSource,
    stage_source,
    validate_staged_source,
)
from .models import SourceFile, SourceManifest

FOLDER_PROVIDER = "preference-example-folder-upload"
MAX_FOLDER_FILES = 500


def validate_folder_paths(paths: list[str]) -> str:
    """Keep one selected root and reject paths that cannot be stored faithfully."""
    if not paths:
        raise MaterialSourceError("请选择包含文件的样本文件夹")
    if len(paths) > MAX_FOLDER_FILES:
        raise MaterialSourceError("文件夹最多支持 500 个文件")
    roots: set[str] = set()
    files: set[str] = set()
    directories: set[str] = set()
    spelling: dict[str, str] = {}
    for path in paths:
        if not isinstance(path, str) or any(unicodedata.category(c) == "Cs" for c in path):
            raise MaterialSourceError("文件夹路径无效，请重新选择文件夹")
        parts = path.split("/")
        if (len(parts) < 2 or len(parts) > 32 or len(path.encode("utf-8")) > 2048
                or any(part in {"", ".", ".."} or part.endswith((" ", "."))
                       or any(c in part for c in "\\:")
                       or any(ord(c) < 32 or ord(c) == 127 for c in part)
                       or len(part.encode("utf-8")) > 255 for part in parts)):
            raise MaterialSourceError("文件夹路径无效，请重新选择文件夹")
        roots.add(parts[0])
        keys = []
        for length in range(1, len(parts) + 1):
            original = "/".join(parts[:length])
            key = unicodedata.normalize("NFC", original).casefold()
            if key in spelling and spelling[key] != original:
                raise MaterialSourceError("文件夹中存在重名或冲突的文件路径")
            spelling[key] = original
            keys.append(key)
        if keys[-1] in files or keys[-1] in directories or any(k in files for k in keys[:-1]):
            raise MaterialSourceError("文件夹中存在重名或冲突的文件路径")
        files.add(keys[-1])
        directories.update(keys[:-1])
    if len(roots) != 1:
        raise MaterialSourceError("请一次选择一个完整的文件夹")
    return next(iter(roots))


async def stage_preference_upload(data_root: Path, form: Any) -> StagedSource:
    """Read a bounded upload, then stage an atomic single-file or folder source."""
    from starlette.concurrency import run_in_threadpool
    from starlette.datastructures import UploadFile

    kind = str(form.get("upload_kind", "file"))
    if kind == "file":
        upload = form.get("sample_file")
        if not isinstance(upload, UploadFile) or not upload.filename:
            raise MaterialSourceError("请选择参考样本文件")
        return await run_in_threadpool(
            stage_source, data_root, content=await upload.read(MAX_SOURCE_BYTES + 1),
            filename=upload.filename, source_type="other", provider="preference-example-upload",
            media_type=upload.content_type, identifier=upload.filename,
        )
    if kind != "folder":
        raise MaterialSourceError("请选择文件或文件夹上传方式")
    uploads = form.getlist("folder_files")
    try:
        paths = json.loads(str(form.get("folder_paths", "[]")))
    except (ValueError, TypeError) as exc:
        raise MaterialSourceError("文件夹路径无效，请重新选择文件夹") from exc
    if not isinstance(paths, list) or len(paths) != len(uploads):
        raise MaterialSourceError("文件夹路径无效，请重新选择文件夹")
    validate_folder_paths(paths)
    entries = []
    size = 0
    for path, upload in zip(paths, uploads, strict=True):
        if not isinstance(upload, UploadFile) or not upload.filename:
            raise MaterialSourceError("文件夹路径无效，请重新选择文件夹")
        content = await upload.read(MAX_SOURCE_BYTES - size + 1)
        size += len(content)
        if size > MAX_SOURCE_BYTES:
            raise MaterialSourceError("文件夹总大小不能超过 50 MB")
        entries.append(SourceAttachment(
            filename=path, content=content,
            media_type=mimetypes.guess_type(path)[0] or "application/octet-stream",
        ))
    return await run_in_threadpool(stage_folder_source, data_root, entries=entries)


def stage_folder_source(data_root: Path, *, entries: list[SourceAttachment]) -> StagedSource:
    folder = validate_folder_paths([entry.filename for entry in entries])
    if sum(len(entry.content) for entry in entries) > MAX_SOURCE_BYTES:
        raise MaterialSourceError("文件夹总大小不能超过 50 MB")
    entries = sorted(entries, key=lambda entry: entry.filename)
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for entry in entries:
            info = zipfile.ZipInfo(entry.filename, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, entry.content)
    if archive.tell() > MAX_SOURCE_BYTES:
        raise MaterialSourceError("文件夹打包后超过 50 MB，请减少文件")
    # stage_source retains the existing single canonical-file invariant. The archive
    # is the immutable original; separately stored members support human browsing.
    staged = stage_source(
        data_root, content=archive.getvalue(), filename="folder.zip", source_type="other",
        provider=FOLDER_PROVIDER, media_type="application/zip", identifier=folder,
    )
    try:
        for entry in entries:
            relative = "files/" + entry.filename
            path = staged.path / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(entry.content)
            staged.manifest.files.append(SourceFile(
                path=relative, role="attachment", media_type=entry.media_type,
                sha256=hashlib.sha256(entry.content).hexdigest(),
            ))
        (staged.path / "manifest.yaml").write_text(yaml.safe_dump(
            staged.manifest.model_dump(mode="json", by_alias=True, exclude_none=True),
            allow_unicode=True, sort_keys=False,
        ), encoding="utf-8")
        return validate_staged_source(data_root, staged.manifest.id)
    except Exception:
        shutil.rmtree(staged.path, ignore_errors=True)
        raise


def is_folder_source(source: SourceManifest) -> bool:
    return source.origin.provider == FOLDER_PROVIDER


def folder_members(source: SourceManifest) -> list[SourceFile]:
    return [item for item in source.files if item.role == "attachment" and item.path.startswith("files/")]


def folder_tree(source: SourceManifest, data_root: Path, record_id: str) -> dict[str, Any]:
    root: dict[str, Any] = {"children": {}}
    for file in folder_members(source):
        parts = file.path.split("/")[2:]  # remove files/ and the uploaded root
        node = root
        for part in parts[:-1]:
            node = node["children"].setdefault(part, {"name": part, "children": {}})
        node["children"][parts[-1]] = {
            "name": parts[-1],
            "id": hashlib.sha256(file.path.encode()).hexdigest()[:16],
            "url": f"/preferences/examples/{record_id}/file?" + urlencode({"path": file.path}),
            "local_path": str((data_root / "sources" / source.id / file.path).resolve()),
        }
    def ordered(node: dict[str, Any]) -> dict[str, Any]:
        if "children" in node:
            node["children"] = [ordered(child) for child in sorted(
                node["children"].values(),
                key=lambda child: ("children" not in child, child["name"].casefold()),
            )]
        return node
    return ordered(root)
