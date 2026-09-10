from __future__ import annotations

import hashlib
import mimetypes
import shutil
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Literal

import yaml
from pydantic import ValidationError

from .frontmatter import FrontmatterError, load_yaml_file
from .models import SourceManifest
from .store import PersonaStore, StoreValidationError

MAX_SOURCE_BYTES = 50 * 1024 * 1024
SourceType = Literal[
    "article",
    "note",
    "paper",
    "book",
    "course_material",
    "conversation",
    "resume",
    "manual_declaration",
    "task_attachment",
    "other",
]


class MaterialSourceError(ValueError):
    """Raised when a Material source cannot be staged or published safely."""


@dataclass(frozen=True)
class StagedSource:
    manifest: SourceManifest
    path: Path


@dataclass(frozen=True)
class SourceAttachment:
    filename: str
    content: bytes
    media_type: str
    role: Literal["attachment", "extracted_text"] = "attachment"


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        cleaned = " ".join(data.split())
        if cleaned:
            self.parts.append(cleaned)

    def text(self) -> str:
        return "\n\n".join(self.parts).strip()


def _utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def _safe_suffix(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix and len(suffix) <= 10 and suffix[1:].isalnum():
        return suffix
    return ".bin"


def _media_type(filename: str, supplied: str | None) -> str:
    if supplied:
        return supplied.split(";", 1)[0].strip().lower() or "application/octet-stream"
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def _extracted_text(content: bytes, media_type: str) -> str | None:
    if media_type in {"text/markdown", "text/plain"}:
        return content.decode("utf-8", errors="replace").strip()
    if media_type == "text/html":
        parser = _TextExtractor()
        parser.feed(content.decode("utf-8", errors="replace"))
        return parser.text()
    return None


def stage_source(
    data_root: Path,
    *,
    content: bytes,
    filename: str,
    source_type: SourceType,
    provider: str,
    media_type: str | None = None,
    identifier: str | None = None,
    version: str | None = None,
    url: str | None = None,
    attachments: list[SourceAttachment] | None = None,
) -> StagedSource:
    if not content:
        raise MaterialSourceError("原文内容不能为空")
    if len(content) > MAX_SOURCE_BYTES:
        raise MaterialSourceError("原文超过 50 MB，当前版本无法导入")
    now = _utc_now()
    source_id = f"src_{uuid.uuid4().hex}"
    staging_root = data_root.resolve() / "sources" / ".staging" / source_id
    if staging_root.exists():
        raise MaterialSourceError("暂存 Source ID 已存在")
    staging_root.mkdir(parents=True)
    try:
        detected_media_type = _media_type(filename, media_type)
        original_name = f"original{_safe_suffix(filename)}"
        original_path = staging_root / original_name
        original_path.write_bytes(content)
        content_hash = hashlib.sha256(content).hexdigest()
        files: list[dict[str, str]] = [
            {
                "path": original_name,
                "role": "original",
                "media_type": detected_media_type,
                "sha256": content_hash,
            }
        ]
        extraction: dict[str, str] | None = None
        extracted = _extracted_text(content, detected_media_type)
        if extracted is not None and detected_media_type != "text/markdown":
            extracted_bytes = (extracted + "\n").encode("utf-8")
            (staging_root / "extracted.md").write_bytes(extracted_bytes)
            files.append(
                {
                    "path": "extracted.md",
                    "role": "extracted_text",
                    "media_type": "text/markdown",
                    "sha256": hashlib.sha256(extracted_bytes).hexdigest(),
                }
            )
            extraction = {"tool": "ai-persona-text-extractor", "version": "1"}
        attachment_names: set[str] = set()
        for attachment in attachments or []:
            name = attachment.filename.strip()
            if (
                not name
                or Path(name).name != name
                or any(character in name for character in "/\\\0")
                or name in attachment_names
            ):
                raise MaterialSourceError("Source 附件文件名无效或重复")
            if len(attachment.content) > MAX_SOURCE_BYTES:
                raise MaterialSourceError("Source 附件超过 50 MB")
            attachment_names.add(name)
            relative_path = f"attachments/{name}"
            attachment_path = staging_root / relative_path
            attachment_path.parent.mkdir(parents=True, exist_ok=True)
            attachment_path.write_bytes(attachment.content)
            files.append(
                {
                    "path": relative_path,
                    "role": attachment.role,
                    "media_type": attachment.media_type,
                    "sha256": hashlib.sha256(attachment.content).hexdigest(),
                }
            )
            if attachment.role == "extracted_text" and extraction is None:
                extraction = {"tool": "ai-persona-import-extractor", "version": "1"}
        manifest = SourceManifest.model_validate(
            {
                "schema": "ai-persona.source-manifest/v2",
                "id": source_id,
                "source_type": source_type,
                "imported_at": now,
                "origin": {
                    "provider": provider,
                    "identifier": identifier,
                    "version": version,
                    "url": url,
                    "retrieved_at": now,
                },
                "canonical_file": original_name,
                "content_hash": content_hash,
                "files": files,
                "extraction": extraction,
            }
        )
        manifest_text = yaml.safe_dump(
            manifest.model_dump(mode="json", by_alias=True, exclude_none=True),
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
        )
        (staging_root / "manifest.yaml").write_text(manifest_text, encoding="utf-8")
        return validate_staged_source(data_root, source_id)
    except ValidationError as exc:
        shutil.rmtree(staging_root, ignore_errors=True)
        raise MaterialSourceError(f"Source Manifest 无效：{exc}") from exc
    except Exception:
        shutil.rmtree(staging_root, ignore_errors=True)
        raise


def stage_pasted_source(
    data_root: Path,
    *,
    text: str,
    source_type: SourceType,
) -> StagedSource:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    return stage_source(
        data_root,
        content=(normalized + "\n").encode("utf-8"),
        filename="original.md",
        source_type=source_type,
        provider="manual-paste",
        media_type="text/markdown",
    )


def stage_url_source(
    data_root: Path,
    *,
    url: str,
    source_type: SourceType,
    identifier: str | None = None,
    version: str | None = None,
) -> StagedSource:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise MaterialSourceError("链接必须是有效的 http 或 https 地址")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "AI-Persona/0.3 (+local personal archive)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            content = response.read(MAX_SOURCE_BYTES + 1)
            content_type = response.headers.get_content_type()
            final_url = response.geturl()
    except (OSError, urllib.error.URLError, ValueError) as exc:
        raise MaterialSourceError(f"无法下载原文：{exc}") from exc
    if len(content) > MAX_SOURCE_BYTES:
        raise MaterialSourceError("下载内容超过 50 MB，当前版本无法导入")
    filename = Path(urllib.parse.urlparse(final_url).path).name or "original.html"
    return stage_source(
        data_root,
        content=content,
        filename=filename,
        source_type=source_type,
        provider=parsed.hostname,
        media_type=content_type,
        identifier=identifier,
        version=version,
        url=final_url,
    )


def validate_staged_source(data_root: Path, source_id: str) -> StagedSource:
    if not source_id.startswith("src_") or any(character in source_id for character in "/\\\0"):
        raise MaterialSourceError("无效的 Source ID")
    path = data_root.resolve() / "sources" / ".staging" / source_id
    manifest_path = path / "manifest.yaml"
    if not manifest_path.is_file():
        raise MaterialSourceError(f"找不到暂存原文：{source_id}")
    try:
        manifest = SourceManifest.model_validate(load_yaml_file(manifest_path))
        if manifest.id != source_id:
            raise MaterialSourceError("Source Manifest ID 与目录不一致")
        PersonaStore(data_root)._verify_source_files(path, manifest)
    except (FrontmatterError, ValidationError, StoreValidationError) as exc:
        raise MaterialSourceError(f"暂存原文无效：{exc}") from exc
    return StagedSource(manifest=manifest, path=path)


def publish_staged_source(data_root: Path, source_id: str) -> tuple[Path, Path]:
    staged = validate_staged_source(data_root, source_id)
    destination = data_root.resolve() / "sources" / source_id
    if destination.exists():
        raise MaterialSourceError(f"正式 Source 已存在：{source_id}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    staged.path.replace(destination)
    return staged.path, destination


def restore_staged_source(staging_path: Path, published_path: Path) -> None:
    if published_path.exists() and not staging_path.exists():
        staging_path.parent.mkdir(parents=True, exist_ok=True)
        published_path.replace(staging_path)


def discard_staged_source(data_root: Path, source_id: str) -> None:
    staged = validate_staged_source(data_root, source_id)
    shutil.rmtree(staged.path)
