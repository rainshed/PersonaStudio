from __future__ import annotations

import hashlib
import json
import mimetypes
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from ..materials import MAX_SOURCE_BYTES, SourceAttachment, StagedSource, stage_source
from ..models import BibliographicIdentifiers, Bibliography
from ..store import PersonaStore
from .arxiv import ArxivImportError, fetch_arxiv_document
from .duplicates import find_duplicate_matches
from .markdown import MarkdownImportError, detect_language, parse_markdown
from .models import DraftFile, ImportDraft, ImportFieldState, ImportMetadata
from .repository import ImportDraftRepository

IMPORT_TTL = timedelta(hours=24)


class MaterialImportError(ValueError):
    """Raised when a supported material cannot be recognized or staged."""


def _digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode(
        "utf-8"
    )


class MaterialImportService:
    def __init__(self, data_root: Path, state_root: Path) -> None:
        self.data_root = data_root.resolve()
        self.repository = ImportDraftRepository(state_root)

    def create_arxiv(self, raw_input: str) -> ImportDraft:
        self.repository.cleanup_expired()
        warnings: list[str] = []
        try:
            document = fetch_arxiv_document(raw_input)
            normalized_doi: str | None = None
            if document.doi:
                try:
                    normalized_doi = BibliographicIdentifiers.model_validate(
                        {"doi": document.doi}
                    ).doi
                except ValueError:
                    warnings.append("arXiv 元数据中的 DOI 无效，已留空。")
            identifiers = BibliographicIdentifiers.model_validate(
                {"arxiv": document.normalized.base_id, "doi": normalized_doi}
            )
            bibliography = Bibliography(
                authors=document.authors,
                published_at=document.published_at,
                venue=document.venue,
                language=detect_language(f"{document.title}\n{document.abstract}"),
                identifiers=identifiers,
                canonical_url=document.normalized.canonical_url,
            )
        except (ArxivImportError, ValueError) as exc:
            raise MaterialImportError(str(exc)) from exc

        values = ImportMetadata(
            material_type="paper",
            title=document.title,
            abstract=document.abstract,
            bibliography=bibliography,
        )
        states: dict[str, ImportFieldState] = {
            "material_type": ImportFieldState(
                source="arxiv_metadata", source_locator="category", status="autofilled"
            ),
            "title": ImportFieldState(
                source="arxiv_metadata", source_locator="atom:title", status="autofilled"
            ),
            "abstract": ImportFieldState(
                source="arxiv_metadata",
                source_locator="atom:summary",
                status="autofilled" if document.abstract else "missing",
            ),
            "bibliography.authors": ImportFieldState(
                source="arxiv_metadata",
                source_locator="atom:author",
                status="autofilled" if document.authors else "missing",
            ),
            "bibliography.published_at": ImportFieldState(
                source="arxiv_metadata",
                source_locator="atom:published",
                status="autofilled" if document.published_at else "missing",
            ),
            "bibliography.identifiers.arxiv": ImportFieldState(
                source="arxiv_metadata", source_locator="atom:id", status="autofilled"
            ),
            "bibliography.canonical_url": ImportFieldState(
                source="arxiv_metadata", source_locator="atom:id", status="autofilled"
            ),
        }
        optional_states = {
            "aliases": ([], "none", None),
            "bibliography.venue": (bibliography.venue, "arxiv_metadata", "arxiv:journal_ref"),
            "bibliography.language": (
                bibliography.language,
                "language_detection",
                "title+abstract",
            ),
            "bibliography.identifiers.doi": (
                bibliography.identifiers.doi,
                "arxiv_metadata",
                "arxiv:doi",
            ),
            "bibliography.identifiers.isbn": (None, "none", None),
        }
        for field, (value, source, locator) in optional_states.items():
            states[field] = ImportFieldState(
                source=source,
                source_locator=locator,
                status=(
                    "review_required"
                    if field == "bibliography.language" and value
                    else "autofilled" if value else "missing"
                ),
            )

        source_hash = _digest(document.pdf)
        metadata_seed = {
            "schema": "ai-persona.extracted-material-metadata/v1",
            "input_kind": "arxiv",
            "source": {
                "provider": "arxiv",
                "identifier": document.normalized.base_id,
                "version": document.version,
                "url": document.normalized.canonical_url,
                "pdf_url": document.pdf_url,
                "html_url": document.html_url,
                "categories": document.categories,
                "requested_input": raw_input.strip(),
                "retrieved_at": datetime.now(timezone.utc)
                .replace(microsecond=0)
                .isoformat()
                .replace("+00:00", "Z"),
            },
            "values": values.model_dump(mode="json"),
            "field_states": {
                name: state.model_dump(mode="json") for name, state in sorted(states.items())
            },
            "warnings": warnings,
            "parser_version": "1",
        }
        files = {
            "original.pdf": document.pdf,
            "attachments/arxiv-metadata.xml": document.atom_xml,
            "attachments/metadata.json": _json_bytes(metadata_seed),
        }
        media_types = {
            "original.pdf": "application/pdf",
            "attachments/arxiv-metadata.xml": "application/atom+xml",
            "attachments/metadata.json": "application/json",
        }
        file_roles: dict[str, str] = {}
        if document.html is not None and document.extracted_text is not None:
            files["attachments/arxiv.html"] = document.html
            files["attachments/extracted.md"] = document.extracted_text
            media_types["attachments/arxiv.html"] = "text/html"
            media_types["attachments/extracted.md"] = "text/markdown"
            file_roles["attachments/extracted.md"] = "extracted_text"
        return self._create_draft(
            input_kind="arxiv",
            original_input=raw_input.strip(),
            display_name=f"{document.normalized.base_id}{document.version}.pdf",
            provider="arxiv",
            identifier=document.normalized.base_id,
            version=document.version,
            url=document.normalized.canonical_url,
            original_file="original.pdf",
            values=values,
            states=states,
            warnings=warnings,
            files=files,
            media_types=media_types,
            file_roles=file_roles,
            source_hash=source_hash,
        )

    def create_markdown(self, filename: str, content: bytes) -> ImportDraft:
        self.repository.cleanup_expired()
        safe_name = Path(filename.replace("\\", "/")).name
        if not safe_name or "\0" in safe_name or Path(safe_name).suffix.casefold() not in {
            ".md",
            ".markdown",
        }:
            raise MaterialImportError("请选择 .md 或 .markdown 文件")
        if len(content) > MAX_SOURCE_BYTES:
            raise MaterialImportError("Markdown 文件超过 50 MB，当前版本无法导入")
        try:
            parsed = parse_markdown(content, safe_name)
        except MarkdownImportError as exc:
            raise MaterialImportError(str(exc)) from exc
        source_hash = _digest(content)
        metadata_seed = {
            "schema": "ai-persona.extracted-material-metadata/v1",
            "input_kind": "markdown",
            "source": {
                "provider": "file-upload",
                "identifier": safe_name,
                "version": None,
                "url": None,
            },
            "values": parsed.values.model_dump(mode="json"),
            "field_states": {
                name: state.model_dump(mode="json")
                for name, state in sorted(parsed.field_states.items())
            },
            "warnings": parsed.warnings,
            "parser_version": "1",
        }
        files = {
            f"original{Path(safe_name).suffix.casefold()}": content,
            "attachments/metadata.json": _json_bytes(metadata_seed),
        }
        return self._create_draft(
            input_kind="markdown",
            original_input=safe_name,
            display_name=safe_name,
            provider="file-upload",
            identifier=safe_name,
            version=None,
            url=None,
            original_file=f"original{Path(safe_name).suffix.casefold()}",
            values=parsed.values,
            states=parsed.field_states,
            warnings=parsed.warnings,
            files=files,
            media_types={
                f"original{Path(safe_name).suffix.casefold()}": "text/markdown",
                "attachments/metadata.json": "application/json",
            },
            file_roles={},
            source_hash=source_hash,
        )

    def _create_draft(
        self,
        *,
        input_kind: str,
        original_input: str,
        display_name: str,
        provider: str,
        identifier: str | None,
        version: str | None,
        url: str | None,
        original_file: str,
        values: ImportMetadata,
        states: dict[str, ImportFieldState],
        warnings: list[str],
        files: dict[str, bytes],
        media_types: dict[str, str],
        file_roles: dict[str, str],
        source_hash: str,
    ) -> ImportDraft:
        now = datetime.now(timezone.utc).replace(microsecond=0)
        duplicates = find_duplicate_matches(
            PersonaStore(self.data_root).load(),
            values,
            source_hash=source_hash,
            source_version=version,
        )
        draft_files = [
            DraftFile(
                path=path,
                role=(
                    "original"
                    if path == original_file
                    else file_roles.get(path, "attachment")
                ),
                media_type=media_types.get(
                    path, mimetypes.guess_type(path)[0] or "application/octet-stream"
                ),
                sha256=_digest(content),
            )
            for path, content in files.items()
        ]
        draft = ImportDraft(
            id=f"imp_{uuid.uuid4().hex}",
            input_kind=input_kind,
            original_input=original_input,
            display_name=display_name,
            source_provider=provider,
            source_identifier=identifier,
            source_version=version,
            source_url=url,
            source_hash=source_hash,
            original_file=original_file,
            files=draft_files,
            values=values,
            field_states=states,
            warnings=warnings,
            duplicate_matches=duplicates,
            created_at=now,
            expires_at=now + IMPORT_TTL,
        )
        return self.repository.create(draft, files)

    def get(self, draft_id: str) -> ImportDraft:
        draft = self.repository.get(draft_id)
        matches = find_duplicate_matches(
            PersonaStore(self.data_root).load(),
            draft.values,
            source_hash=draft.source_hash,
            source_version=draft.source_version,
        )
        if matches != draft.duplicate_matches:
            draft = draft.model_copy(update={"duplicate_matches": matches})
            self.repository.save(draft)
        return draft

    def stage_draft(
        self, draft_id: str, *, material_type: str,
        extra_attachments: list[SourceAttachment] | None = None,
    ) -> StagedSource:
        draft = self.repository.get(draft_id)
        original = self.repository.file_path(draft, draft.original_file).read_bytes()
        original_info = next(item for item in draft.files if item.path == draft.original_file)
        attachments = [
            SourceAttachment(
                filename=Path(item.path).name,
                content=self.repository.file_path(draft, item.path).read_bytes(),
                media_type=item.media_type,
                role="extracted_text" if item.role == "extracted_text" else "attachment",
            )
            for item in draft.files
            if item.role != "original"
        ]
        return stage_source(
            self.data_root,
            content=original,
            filename=draft.display_name,
            source_type=material_type,  # type: ignore[arg-type]
            provider=draft.source_provider,
            media_type=original_info.media_type,
            identifier=draft.source_identifier,
            version=draft.source_version,
            url=draft.source_url,
            attachments=[*attachments, *(extra_attachments or [])],
        )

    def delete(self, draft_id: str) -> None:
        self.repository.delete(draft_id)
