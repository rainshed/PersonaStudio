from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from ..frontmatter import FrontmatterError, load_yaml_text
from ..models import BibliographicIdentifiers, Bibliography
from .arxiv import normalize_arxiv_input
from .models import ImportFieldState, ImportMetadata

MATERIAL_TYPES = {
    "article",
    "note",
    "paper",
    "book",
    "course_material",
    "conversation",
    "resume",
    "other",
}


class MarkdownImportError(ValueError):
    """Raised when a Markdown upload is empty, binary, or not UTF-8."""


@dataclass(frozen=True)
class ParsedMarkdown:
    values: ImportMetadata
    field_states: dict[str, ImportFieldState]
    warnings: list[str]


def detect_language(value: str) -> str | None:
    cjk = len(re.findall(r"[\u3400-\u9fff]", value))
    latin = len(re.findall(r"[A-Za-z]", value))
    if cjk >= 2 and cjk >= latin * 0.05:
        return "zh"
    if latin >= 3:
        return "en"
    return None


def _clean_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).replace("\r\n", "\n").replace("\r", "\n").strip()


def _normalized_date(value: Any) -> str | None:
    text = _clean_text(value)
    if not text:
        return None
    for pattern, output in (
        ("%Y-%m-%d", "%Y-%m-%d"),
        ("%Y-%m", "%Y-%m"),
        ("%Y", "%Y"),
        ("%B %d, %Y", "%Y-%m-%d"),
        ("%b %d, %Y", "%Y-%m-%d"),
    ):
        try:
            return datetime.strptime(text, pattern).strftime(output)
        except ValueError:
            continue
    return None


def _normalized_language(value: Any) -> str | None:
    text = _clean_text(value).replace("_", "-").casefold()
    if not text:
        return None
    aliases = {"english": "en", "chinese": "zh", "中文": "zh", "英文": "en"}
    return aliases.get(text, text.split("-", 1)[0])


def _normalized_identifier(kind: str, value: Any) -> str | None:
    text = _clean_text(value)
    if not text:
        return None
    try:
        if kind == "arxiv":
            return normalize_arxiv_input(text).base_id
        identifiers = BibliographicIdentifiers.model_validate({kind: text})
        return getattr(identifiers, kind)
    except ValueError:
        return None


def _normalized_url(value: Any) -> str | None:
    text = _clean_text(value)
    if not text:
        return None
    try:
        return Bibliography(canonical_url=text).canonical_url
    except ValueError:
        return None


def _string_list(value: Any) -> tuple[list[str], bool]:
    if isinstance(value, list):
        values = [_clean_text(item) for item in value]
        return list(dict.fromkeys(item for item in values if item)), True
    text = _clean_text(value)
    if not text:
        return [], False
    parts = re.split(r"\n+|\s*;\s*|\s+and\s+", text)
    values = list(dict.fromkeys(item.strip() for item in parts if item.strip()))
    return values, False


def _frontmatter(text: str) -> tuple[dict[str, Any], str, list[str]]:
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].lstrip("\ufeff").strip() != "---":
        return {}, text, []
    closing = next(
        (index for index, line in enumerate(lines[1:], start=1) if line.strip() == "---"),
        None,
    )
    if closing is None:
        return {}, text, ["Markdown frontmatter 没有结束标记，已改用正文结构识别。"]
    frontmatter_text = "".join(lines[1:closing])
    body = "".join(lines[closing + 1 :])
    try:
        return load_yaml_text(frontmatter_text, source="Markdown frontmatter"), body, []
    except FrontmatterError as exc:
        return {}, body, [f"Markdown frontmatter 无效，已改用正文结构识别：{exc}"]


def _first_h1(body: str) -> tuple[str | None, int | None]:
    for index, line in enumerate(body.splitlines()):
        match = re.match(r"^#\s+(.+?)\s*#*\s*$", line)
        if match:
            return match.group(1).strip(), index
    return None, None


def _abstract_section(body: str) -> tuple[str | None, int | None]:
    lines = body.splitlines()
    start: int | None = None
    level = 0
    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s*(abstract|摘要)\s*#*\s*$", line, re.IGNORECASE)
        if match:
            start = index
            level = len(match.group(1))
            break
    if start is None:
        return None, None
    end = len(lines)
    for index in range(start + 1, len(lines)):
        match = re.match(r"^(#{1,6})\s+", lines[index])
        if match and len(match.group(1)) <= level:
            end = index
            break
    abstract = "\n".join(lines[start + 1 : end]).strip()
    return abstract or None, start


def _author_candidates(body: str, h1_index: int | None, abstract_index: int | None) -> list[str]:
    if h1_index is None or abstract_index is None or abstract_index <= h1_index + 1:
        return []
    lines = body.splitlines()
    candidate_line = next(
        (
            line.strip()
            for line in lines[h1_index + 1 : abstract_index]
            if line.strip() and not re.match(r"^\(?(?:Dated|Published)\s*:", line.strip(), re.I)
        ),
        "",
    )
    if not candidate_line:
        return []
    candidate_line = re.split(r"<br\s*/?>", candidate_line, maxsplit=1, flags=re.I)[0]
    candidate_line = re.sub(r"\$\{\s*\}\^\{[^$]*?\}\$", " ", candidate_line)
    candidate_line = re.sub(r"\$[^$]*\$", " ", candidate_line)
    candidate_line = re.sub(r"<[^>]+>", " ", candidate_line)
    candidate_line = candidate_line.replace("†", " ").replace("*", " ")
    candidate_line = re.sub(r"\s+and\s+", ", ", candidate_line, flags=re.I)
    ignored = re.compile(
        r"\b(?:university|institute|department|laboratory|college|school|academy|center|centre)\b",
        re.I,
    )
    result: list[str] = []
    for part in re.split(r"\s*,\s*|\s*;\s*", candidate_line):
        cleaned = re.sub(r"^[\s.·-]+|[\s.·-]+$", "", part)
        cleaned = re.sub(r"\s+", " ", cleaned)
        if (
            not cleaned
            or any(character.isdigit() for character in cleaned)
            or "@" in cleaned
            or ignored.search(cleaned)
            or len(cleaned.split()) > 8
        ):
            continue
        result.append(cleaned)
    return list(dict.fromkeys(result))


def _date_from_body(body: str) -> str | None:
    match = re.search(
        r"(?im)^\s*\(?(?:Dated|Published)\s*:\s*([^\n)]+)\)?\s*$",
        body,
    )
    return _normalized_date(match.group(1)) if match else None


def _arxiv_from_body(body: str) -> str | None:
    patterns = (
        r"(?i)arxiv\s*:\s*((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(?:v\d+)?)",
        r"(?i)arxiv\.org/(?:abs|pdf)/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?/\d{7})(?:v\d+)?)",
    )
    for pattern in patterns:
        match = re.search(pattern, body)
        if match:
            try:
                return normalize_arxiv_input(match.group(1)).base_id
            except ValueError:
                pass
    return None


def _doi_from_body(body: str) -> str | None:
    match = re.search(r"(?i)\b10\.\d{4,9}/[^\s<>\[\]\"']+", body)
    if not match:
        return None
    return _normalized_identifier("doi", match.group(0).rstrip(".,;:)"))


def parse_markdown(content: bytes, filename: str) -> ParsedMarkdown:
    if not content:
        raise MarkdownImportError("Markdown 文件不能为空")
    if b"\0" in content:
        raise MarkdownImportError("文件不是可读取的 Markdown 文本")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise MarkdownImportError("Markdown 文件必须使用 UTF-8 编码") from exc
    if not text.strip():
        raise MarkdownImportError("Markdown 文件不能为空")

    raw, body, warnings = _frontmatter(text)
    states: dict[str, ImportFieldState] = {}

    def state(
        field: str,
        source: str,
        locator: str | None,
        *,
        review: bool = False,
        field_warnings: list[str] | None = None,
    ) -> None:
        states[field] = ImportFieldState(
            source=source,
            source_locator=locator,
            status="review_required" if review else "autofilled",
            warnings=field_warnings or [],
        )

    def first(*names: str) -> tuple[Any, str | None]:
        for name in names:
            if name in raw:
                value = raw[name]
                if value is not None and value != "":
                    return value, name
        return None, None

    title_value, title_key = first("title", "name")
    title = _clean_text(title_value)
    if title:
        state("title", "markdown_frontmatter", title_key)
    h1, h1_index = _first_h1(body)
    if not title and h1:
        title = h1
        state("title", "markdown_h1", f"line:{(h1_index or 0) + 1}")
    if not title:
        title = Path(filename).stem.strip()
        state("title", "filename", filename, review=True)

    abstract_value, abstract_key = first("abstract", "description")
    abstract = _clean_text(abstract_value)
    if abstract:
        state("abstract", "markdown_frontmatter", abstract_key)
    section_abstract, abstract_index = _abstract_section(body)
    if not abstract and section_abstract:
        abstract = section_abstract
        state("abstract", "markdown_section", f"line:{(abstract_index or 0) + 1}")

    authors_value, authors_key = first("authors", "author")
    authors, authors_are_list = _string_list(authors_value)
    if authors:
        state(
            "bibliography.authors",
            "markdown_frontmatter",
            authors_key,
            review=not authors_are_list,
        )
    if not authors:
        authors = _author_candidates(body, h1_index, abstract_index)
        if authors:
            state(
                "bibliography.authors",
                "markdown_structure",
                "between:title-and-abstract",
                review=True,
            )

    aliases_value, aliases_key = first("aliases")
    aliases, aliases_are_list = _string_list(aliases_value)
    if aliases:
        state("aliases", "markdown_frontmatter", aliases_key, review=not aliases_are_list)

    date_value, date_key = first("published_at", "published", "date")
    published_at = _normalized_date(date_value)
    if date_value is not None and date_value != "":
        if published_at:
            state("bibliography.published_at", "markdown_frontmatter", date_key)
        else:
            warning = "frontmatter 中的发表时间无法规范化，已留空。"
            warnings.append(warning)
            state(
                "bibliography.published_at",
                "markdown_frontmatter",
                date_key,
                review=True,
                field_warnings=[warning],
            )
    if not published_at:
        published_at = _date_from_body(body)
        if published_at:
            state("bibliography.published_at", "markdown_pattern", "dated-line", review=True)

    venue_value, venue_key = first("venue", "journal")
    venue = _clean_text(venue_value) or None
    if venue:
        state("bibliography.venue", "markdown_frontmatter", venue_key)

    language_value, language_key = first("language", "lang")
    language = _normalized_language(language_value)
    if language:
        state("bibliography.language", "markdown_frontmatter", language_key)
    if not language:
        language = detect_language(f"{title}\n{abstract}")
        if language:
            state("bibliography.language", "language_detection", "title+abstract", review=True)

    arxiv_value, arxiv_key = first("arxiv", "arxiv_id")
    arxiv = _normalized_identifier("arxiv", arxiv_value)
    if arxiv_value is not None and arxiv_value != "":
        if arxiv:
            state("bibliography.identifiers.arxiv", "markdown_frontmatter", arxiv_key)
        else:
            warnings.append("frontmatter 中的 arXiv ID 无效，已留空。")
    if not arxiv:
        arxiv = _arxiv_from_body(body)
        if arxiv:
            state("bibliography.identifiers.arxiv", "markdown_pattern", "document-text", review=True)

    doi_value, doi_key = first("doi")
    doi = _normalized_identifier("doi", doi_value)
    if doi_value is not None and doi_value != "":
        if doi:
            state("bibliography.identifiers.doi", "markdown_frontmatter", doi_key)
        else:
            warnings.append("frontmatter 中的 DOI 无效，已留空。")
    if not doi:
        doi = _doi_from_body(body)
        if doi:
            state("bibliography.identifiers.doi", "markdown_pattern", "document-text", review=True)

    url_value, url_key = first("canonical_url", "url")
    canonical_url = _normalized_url(url_value)
    if url_value is not None and url_value != "":
        if canonical_url:
            state("bibliography.canonical_url", "markdown_frontmatter", url_key)
        else:
            warnings.append("frontmatter 中的规范链接无效，已留空。")
    if not canonical_url and arxiv:
        canonical_url = f"https://arxiv.org/abs/{arxiv}"
        state("bibliography.canonical_url", "derived_from_arxiv", "arxiv", review=True)

    type_value, type_key = first("material_type", "type")
    material_type = _clean_text(type_value).casefold()
    if material_type in MATERIAL_TYPES:
        state("material_type", "markdown_frontmatter", type_key)
    else:
        if material_type:
            warnings.append("frontmatter 中的材料类型不受支持，已根据文档结构判断。")
        material_type = "paper" if authors and abstract else "note"
        state("material_type", "markdown_structure", "document-structure", review=True)

    bibliography = Bibliography.model_validate(
        {
            "authors": authors,
            "published_at": published_at,
            "venue": venue,
            "language": language,
            "identifiers": {"arxiv": arxiv, "doi": doi, "isbn": None},
            "canonical_url": canonical_url,
        }
    )
    values = ImportMetadata(
        material_type=material_type,
        title=title,
        aliases=aliases,
        abstract=abstract,
        bibliography=bibliography,
    )
    for field in (
        "aliases",
        "abstract",
        "bibliography.authors",
        "bibliography.published_at",
        "bibliography.venue",
        "bibliography.language",
        "bibliography.identifiers.arxiv",
        "bibliography.identifiers.doi",
        "bibliography.identifiers.isbn",
        "bibliography.canonical_url",
    ):
        states.setdefault(field, ImportFieldState(source="none", status="missing"))
    return ParsedMarkdown(values=values, field_states=states, warnings=warnings)
