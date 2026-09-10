"""Manifest-bound source reading and excerpts; never exposes host paths."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
import threading
from contextlib import closing
from functools import wraps
from pathlib import Path, PurePosixPath
from typing import Any

from PIL import Image

from .agent import AgentServiceError
from .models import SourceFile
from .query_contracts import SourceSelector, digest, encoded, pack
from .store import PersonaStore

EXTRACTOR_VERSION = "persona-reader-1"
_pdf_lock = threading.RLock()  # PDFium is not thread safe, including separate documents.
TEXT_SUFFIXES = {".md", ".txt", ".rst", ".csv", ".tsv", ".json", ".xml", ".html",
                 ".py", ".js", ".ts", ".css", ".yaml", ".yml", ".toml", ".tex", ".svg"}


def file_id(file: SourceFile) -> str:
    return "file_" + hashlib.sha256(file.path.encode()).hexdigest()[:24]


def source_provenance(source_id: str, file: SourceFile, locator: dict | None = None) -> dict:
    value = {"kind": "source", "source_id": source_id, "file_id": file_id(file),
             "file_hash": "sha256:" + file.sha256}
    if locator is not None:
        value["locator"] = locator
    if file.role == "extracted_text":
        value["representation"] = "extracted_text"
    return value


def invalid(message: str):
    raise AgentServiceError("invalid_arguments", message)


def source_read(operation):
    @wraps(operation)
    def wrapped(*args, **kwargs):
        try:
            return operation(*args, **kwargs)
        except AgentServiceError:
            raise
        except Exception as exc:
            raise AgentServiceError("parse_failed", "The requested source view could not be read.") from exc
    return wrapped


class SourceReader:
    def __init__(self, store: PersonaStore, state_root: Path, allowed_sources: set[str]):
        self.store = store
        self.cache = state_root / "query-documents"
        self.allowed_sources = allowed_sources

    def manifest(self, source_id: str):
        if source_id not in self.allowed_sources or source_id not in self.store.sources:
            raise AgentServiceError("not_found_or_not_visible", "Source is not available.")
        return self.store.sources[source_id]

    def resolve(self, source_id: str, fid: str) -> SourceFile:
        manifest = self.manifest(source_id)
        for item in manifest.files:
            if file_id(item) == fid:
                return item
        raise AgentServiceError("not_found_or_not_visible", "File is not available.")

    def by_path(self, source_id: str, relative: str) -> SourceFile:
        for item in self.manifest(source_id).files:
            if item.path == relative:
                return item
        raise AgentServiceError("not_found_or_not_visible", "Declared file is not available.")

    def provenance(self, source_id: str, file: SourceFile, locator=None) -> dict:
        result = source_provenance(source_id, file, locator)
        if file.role == "extracted_text":
            source = self.manifest(source_id)
            result["derived_from"] = [source_provenance(source_id, original)
                                      for original in source.files if original.role == "original"]
            result["extractor_version"] = None  # Import did not record an extractor version.
        return result

    def content(self, source_id: str, file: SourceFile) -> bytes:
        path = self.store.source_file_path(source_id, file.path)
        if path.stat().st_size > 50 * 1024 * 1024:
            raise AgentServiceError("file_too_large", "Source file exceeds the 50 MB reader limit.")
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != file.sha256:
            raise AgentServiceError("source_changed", "Source content does not match its manifest.")
        return content

    @staticmethod
    def views(file: SourceFile) -> list[str]:
        suffix = PurePosixPath(file.path).suffix.lower()
        if file.media_type == "application/pdf" or suffix == ".pdf":
            return ["outline", "text", "image"]
        if file.media_type.startswith("text/") or suffix in TEXT_SUFFIXES:
            return ["outline", "text", *(["structured"] if suffix in {".csv", ".tsv"} else [])]
        if file.media_type in {"image/png", "image/jpeg", "image/webp", "image/gif",
                               "image/tiff", "image/bmp"}:
            return ["image"]
        return []

    def document(self, source_id: str, file: SourceFile) -> dict:
        raw = self.content(source_id, file)
        if "text" not in self.views(file):
            raise AgentServiceError("unsupported_view", "This file has no text reader.",
                                    details={"available_views": self.views(file)})
        key = digest({"file": file.sha256, "version": EXTRACTOR_VERSION,
                      "type": file.media_type, "suffix": PurePosixPath(file.path).suffix})
        cache_path = self.cache / f"{key}.json"
        if cache_path.exists():
            try:
                cached = json.loads(cache_path.read_text())
                if cached["key"] == key:
                    return cached
            except (OSError, ValueError, KeyError):
                pass
        pdf = file.media_type == "application/pdf" or file.path.lower().endswith(".pdf")
        pages = []
        outline = []
        try:
            if pdf:
                import pypdfium2 as pdfium

                with _pdf_lock, pdfium.PdfDocument(raw) as doc:
                    if len(doc) > 2000:
                        raise AgentServiceError("file_too_large", "PDF exceeds 2000 pages.")
                    for i in range(len(doc)):
                        with closing(doc[i]) as page, closing(page.get_textpage()) as textpage:
                            pages.append(textpage.get_text_range().replace("\r\n", "\n"))
                    for entry in doc.get_toc():
                        page = entry.page_index
                        if page is not None and page >= 0:
                            outline.append({"id": f"page_{page + 1}", "title": entry.title,
                                            "level": entry.level + 1,
                                            "selector": {"pages": [page + 1]}})
            else:
                pages = [raw.decode("utf-8-sig", errors="replace")]
                lines = pages[0].splitlines(keepends=True)
                for i, line in enumerate(lines):
                    match = re.match(r"^(#{1,6})\s+(.+)", line)
                    if match:
                        outline.append({"id": f"line_{i + 1}", "title": match[2].strip(),
                                        "level": len(match[1]),
                                        "selector": {"lines": {"start": i + 1, "end": len(lines)}}})
                for i in range(len(outline) - 1):
                    outline[i]["selector"]["lines"]["end"] = (
                        outline[i + 1]["selector"]["lines"]["start"] - 1
                    )
            if not outline:
                outline = [
                    {"id": f"page_{i + 1}", "title": f"Page {i + 1}" if pdf else file.path,
                     "level": 1, "selector": {"pages": [i + 1]} if pdf else
                     {"lines": {"start": 1, "end": max(1, len(text.splitlines()))}}}
                    for i, text in enumerate(pages)
                ]
        except AgentServiceError:
            raise
        except Exception as exc:
            raise AgentServiceError("parse_failed", "The source document could not be parsed.") from exc
        result = {"key": key, "pages": pages, "outline": outline, "pdf": pdf,
                  "extractor_version": EXTRACTOR_VERSION,
                  "has_text": any(p.strip() for p in pages)}
        self.cache.mkdir(parents=True, exist_ok=True)
        # Publication locking serializes requests within a workspace.
        temp = cache_path.with_suffix(".tmp")
        temp.write_text(encoded(result))
        temp.replace(cache_path)
        return result

    def entry(self, source_id: str, file: SourceFile) -> dict:
        entry = {
            "file_id": file_id(file), "relative_path": file.path, "kind": "file",
            "role": file.role, "file_type": file.media_type,
            "file_hash": "sha256:" + file.sha256, "available_views": self.views(file),
            "provenance": self.provenance(source_id, file),
            "parse_status": "unsupported" if not self.views(file) else "ready",
        }
        try:
            entry["size"] = len(self.content(source_id, file))
            if "text" in entry["available_views"]:
                doc = self.document(source_id, file)
                entry.update(page_count=len(doc["pages"]) if doc["pdf"] else None,
                             line_count=None if doc["pdf"] else len(doc["pages"][0].splitlines()),
                             parse_status="ready" if doc["has_text"] else "no_text")
        except (AgentServiceError, OSError, ValueError) as exc:
            entry.update(parse_status="failed", error=getattr(exc, "code", "source_unavailable"))
        return entry

    def entries(self, source_id: str, directory: str, recursive: bool,
                file_types: list[str] | None) -> list[dict]:
        manifest = self.manifest(source_id)
        normalized = directory.rstrip("/")
        if normalized in {"", "."}:
            normalized = ""
        if ("\\" in normalized or "\0" in normalized or normalized.startswith("/")
                or any(p == ".." for p in normalized.split("/"))):
            invalid("directory must be a source-relative directory.")
        prefix = normalized + "/" if normalized else ""
        result = {}
        for item in manifest.files:
            if not item.path.startswith(prefix):
                continue
            if file_types and not any(
                item.media_type == t or item.path.lower().endswith("." + t.lstrip(".").lower())
                for t in file_types
            ):
                continue
            remaining = item.path[len(prefix):]
            if "/" in remaining and not recursive:
                path = prefix + remaining.split("/")[0]
                result.setdefault(path, {
                    "kind": "directory", "relative_path": path, "file_count": 0,
                    "provenance": {"kind": "source_manifest", "source_id": source_id,
                                   "source_hash": "sha256:" + manifest.content_hash},
                })["file_count"] += 1
            else:
                result[item.path] = self.entry(source_id, item)
        return sorted(result.values(), key=lambda r: (r["kind"] != "directory", r["relative_path"]))

    def chunks(self, source_id: str, file: SourceFile) -> list[dict]:
        doc = self.document(source_id, file)
        chunks = []
        for page_index, text in enumerate(doc["pages"]):
            lines = text.splitlines(keepends=True)
            start = 0
            while start < len(lines):
                end = start
                length = 0
                while end < len(lines) and (length < 1400 or end == start):
                    length += len(lines[end])
                    end += 1
                full = "".join(lines[start:end])
                for offset in range(0, max(1, len(full)), 1400):
                    piece = full[offset:offset + 1600]
                    if not piece.strip():
                        continue
                    selector = {"lines": {"start": start + 1, "end": end},
                                "offset": offset, "length": len(piece)}
                    if doc["pdf"]:
                        # Lines are coordinates in the extracted page, not in a Markdown file.
                        selector = {"pages": [page_index + 1],
                                    "offset": sum(len(v) for v in lines[:start]) + offset,
                                    "length": len(piece)}
                    locator = {"representation": "pdf_text" if doc["pdf"] else "original_text",
                               **selector}
                    prov = self.provenance(source_id, file, locator)
                    if doc["pdf"]:
                        prov["extractor_version"] = EXTRACTOR_VERSION
                    reference = pack({"source_id": source_id, "file_id": file_id(file),
                                      "file_hash": file.sha256, "selector": selector,
                                      "extractor_version": EXTRACTOR_VERSION})
                    chunks.append({
                        "id": digest({"file": file.sha256, "locator": locator}),
                        "file_ref": {"source_id": source_id, "file_id": file_id(file)},
                        "section_title": self._section(doc, start + 1, page_index + 1),
                        "text": piece, "locator": locator, "passage_ref": reference,
                        "provenance": prov,
                    })
                start = end if end >= len(lines) else max(start + 1, end - 2)
        return chunks

    @staticmethod
    def _section(doc: dict, line: int, page: int) -> str | None:
        matches = []
        for heading in doc["outline"]:
            selector = heading["selector"]
            if doc["pdf"] and selector.get("pages", [page + 1])[0] <= page:
                matches.append(heading["title"])
            elif not doc["pdf"] and selector.get("lines", {}).get("start", line + 1) <= line:
                matches.append(heading["title"])
        return matches[-1] if matches else None

    @source_read
    def read(self, source_id: str, file: SourceFile, view: str, selector: SourceSelector,
             max_chars: int, max_images: int) -> tuple[dict, list[bytes]]:
        views = self.views(file)
        if view == "auto":
            view = "outline" if "outline" in views else "image"
        if view not in views:
            raise AgentServiceError("unsupported_view", "Requested view is not supported.",
                                    details={"available_views": views})
        if sum(x is not None for x in (selector.lines, selector.pages, selector.section_id,
                                       selector.range)) > 1:
            invalid("Use one selector kind at a time.")
        result: dict[str, Any] = {
            "view": view, "file_ref": {"source_id": source_id, "file_id": file_id(file)},
            "provenance": self.provenance(source_id, file),
            "truncated": False, "next_selector": None,
        }
        images = []
        if view == "image":
            if (selector.lines or selector.section_id or selector.range or selector.offset
                    or selector.length is not None):
                invalid("Images accept page selection only.")
            raw = self.content(source_id, file)
            if file.media_type == "application/pdf" or file.path.lower().endswith(".pdf"):
                import pypdfium2 as pdfium

                with _pdf_lock, pdfium.PdfDocument(raw) as doc:
                    pages = selector.pages or [1]
                    self._check_pages(pages, len(doc))
                    for number in pages[:max_images]:
                        with closing(doc[number - 1]) as page:
                            scale = min(2.0, 2000 / max(page.get_size()))
                            bitmap = page.render(scale=scale)
                            try:
                                image = bitmap.to_pil().copy()
                            finally:
                                bitmap.close()
                            images.append(self._png(image))
                    result["selection"] = {"pages": pages[:max_images]}
                    result["page_count"] = len(doc)
                    if len(pages) > max_images:
                        result.update(truncated=True, next_selector={"pages": pages[max_images:]})
            else:
                if selector.pages and selector.pages != [1]:
                    invalid("A source image has one image page.")
                with Image.open(io.BytesIO(raw)) as image:
                    images.append(self._png(image.copy()))
                result["selection"] = {"pages": [1]}
            result["images"] = [
                {"content_block_index": i + 1, "page": result["selection"]["pages"][i],
                 "mime_type": "image/png", "rendered_size": self._image_size(images[i]),
                 "provenance": {**result["provenance"],
                                "locator": {"pages": [result["selection"]["pages"][i]]}}}
                for i in range(len(images))
            ]
            return result, images
        doc = self.document(source_id, file)
        if doc["pdf"]:
            result["provenance"]["extractor_version"] = EXTRACTOR_VERSION
            result["provenance"]["representation"] = "pdf_text"
        if view == "outline" and (selector.lines or selector.pages or selector.section_id
                                  or selector.range or selector.length is not None):
            invalid("Outline uses an entry offset only; use text to read a selected section.")
        if selector.section_id:
            heading = next((h for h in doc["outline"] if h["id"] == selector.section_id), None)
            if heading is None:
                invalid("Unknown section_id.")
            selector = SourceSelector.model_validate({**heading["selector"],
                                                      "offset": selector.offset,
                                                      "length": selector.length})
        if view == "outline":
            start = selector.offset
            output = []
            used = 0
            for row in doc["outline"][start:]:
                size = len(encoded(row))
                if used + size > max_chars:
                    break
                output.append(row)
                used += size
            if not output and start < len(doc["outline"]):
                raise AgentServiceError("budget_too_small", "Increase max_chars for this outline.")
            result.update(outline=output, page_count=len(doc["pages"]) if doc["pdf"] else None,
                          has_text=doc["has_text"], selection={"offset": start})
            if start + len(output) < len(doc["outline"]):
                result.update(truncated=True, next_selector={"offset": start + len(output)})
            return result, images
        if view == "structured":
            if selector.lines or selector.pages or selector.length is not None:
                invalid("Structured CSV reading uses an A1 range or a row offset.")
            rows = list(csv.reader(io.StringIO(doc["pages"][0]),
                                   delimiter="\t" if file.path.endswith(".tsv") else ","))
            first, last, col_start, col_end = self._csv_range(selector.range, rows)
            first += selector.offset
            if first > last:
                invalid("Row offset is outside the selected range.")
            output = []
            for row in rows[first:last]:
                candidate = row[col_start:col_end]
                if len(encoded(output + [candidate])) > max_chars:
                    break
                output.append(candidate)
            if not output and first < last:
                raise AgentServiceError("budget_too_small", "Increase max_chars for this row.")
            result.update(rows=output, selection={"range": selector.range,
                          "row_start": first + 1, "row_end": first + len(output)})
            if first + len(output) < last:
                result.update(truncated=True, next_selector={
                    "range": selector.range, "offset": selector.offset + len(output)})
            return result, images
        if selector.range:
            invalid("Text view does not accept a table range.")
        if doc["pdf"]:
            if selector.lines:
                invalid("PDF text uses page selectors, not Markdown line numbers.")
            pages = selector.pages or list(range(1, len(doc["pages"]) + 1))
            self._check_pages(pages, len(doc["pages"]))
            full_text = "\n\n".join(doc["pages"][p - 1] for p in pages)
            selected = {"pages": pages}
        else:
            if selector.pages and selector.pages != [1]:
                invalid("This text source has one text representation.")
            lines = doc["pages"][0].splitlines(keepends=True)
            start = selector.lines.start if selector.lines else 1
            end = selector.lines.end if selector.lines else max(1, len(lines))
            if start > end or end > max(1, len(lines)):
                invalid("Line range is outside this source.")
            full_text = "".join(lines[start - 1:end])
            selected = {"lines": {"start": start, "end": end}}
        stop = len(full_text)
        if selector.length is not None:
            stop = min(stop, selector.offset + selector.length)
        if selector.offset > stop:
            invalid("Text offset is outside the selected content.")
        text = full_text[selector.offset:min(stop, selector.offset + max_chars)]
        result.update(text=text, selection={**selected, "offset": selector.offset,
                                           "length": len(text)})
        result["provenance"]["locator"] = result["selection"]
        if selector.offset + len(text) < stop:
            result.update(truncated=True, next_selector={
                **selected, "offset": selector.offset + len(text),
                "length": stop - selector.offset - len(text),
            })
        return result, images

    @staticmethod
    def _check_pages(pages: list[int], total: int):
        if (not pages or len(set(pages)) != len(pages)
                or any(type(p) is not int or p < 1 or p > total for p in pages)):
            invalid("Page numbers must be unique and inside the source.")

    @staticmethod
    def _image_size(content: bytes) -> list[int]:
        with Image.open(io.BytesIO(content)) as image:
            return list(image.size)

    @staticmethod
    def _png(image: Image.Image) -> bytes:
        image.thumbnail((2000, 2000))
        if image.mode not in {"RGB", "RGBA", "L", "LA"}:
            image = image.convert("RGB")
        stream = io.BytesIO()
        image.save(stream, format="PNG")
        return stream.getvalue()

    @staticmethod
    def _csv_range(value: str | None, rows: list[list[str]]) -> tuple[int, int, int, int]:
        if value is None:
            return 0, len(rows), 0, max((len(r) for r in rows), default=0)
        match = re.fullmatch(r"([A-Za-z]+)([1-9][0-9]*):([A-Za-z]+)([1-9][0-9]*)", value)
        if not match:
            invalid("Use an A1 range such as A1:D20.")
        def column(name):
            result = 0
            for c in name.upper():
                result = result * 26 + ord(c) - ord("A") + 1
            return result
        start, end = int(match[2]) - 1, int(match[4])
        left, right = column(match[1]) - 1, column(match[3])
        if start >= end or left >= right or end > len(rows):
            invalid("Table range is outside the source.")
        return start, end, left, right
