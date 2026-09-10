from __future__ import annotations

import re
import ssl
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path

from ..materials import MAX_SOURCE_BYTES

MAX_METADATA_BYTES = 2 * 1024 * 1024
ARXIV_HOSTS = {"arxiv.org", "www.arxiv.org", "export.arxiv.org"}
ARXIV_ID_PATTERN = re.compile(
    r"(?P<base>(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7}))"
    r"(?P<version>v\d+)?",
    flags=re.IGNORECASE,
)


class ArxivImportError(ValueError):
    """Raised when an arXiv identifier, metadata response, or PDF is invalid."""


class _OfficialRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(  # type: ignore[no-untyped-def]
        self, req, fp, code, msg, headers, newurl
    ):
        parsed = urllib.parse.urlparse(newurl)
        if parsed.scheme != "https" or parsed.hostname not in ARXIV_HOSTS:
            raise ArxivImportError("arXiv 请求被重定向到不受信任的地址")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


@dataclass(frozen=True)
class NormalizedArxivInput:
    base_id: str
    requested_version: str | None
    original_input: str

    @property
    def requested_id(self) -> str:
        return self.base_id + (self.requested_version or "")

    @property
    def canonical_url(self) -> str:
        return f"https://arxiv.org/abs/{self.base_id}"


@dataclass(frozen=True)
class ArxivDocument:
    normalized: NormalizedArxivInput
    version: str
    title: str
    authors: list[str]
    abstract: str
    published_at: str | None
    venue: str | None
    doi: str | None
    categories: list[str]
    pdf_url: str
    atom_xml: bytes
    pdf: bytes
    html: bytes | None
    html_url: str | None
    extracted_text: bytes | None


class _StructuredHTMLExtractor(HTMLParser):
    """Turn arXiv HTML into compact Markdown-like text without third-party parsers."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0
        self.heading_level: int | None = None
        self.in_list_item = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        if tag in {"script", "style", "nav"}:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if re.fullmatch(r"h[1-6]", tag):
            self.heading_level = int(tag[1])
            self.parts.append("\n\n" + "#" * self.heading_level + " ")
        elif tag in {"p", "section", "article", "div", "figure", "figcaption", "table", "tr"}:
            self.parts.append("\n\n")
        elif tag == "li":
            self.in_list_item = True
            self.parts.append("\n- ")
        elif tag == "br":
            self.parts.append("\n")
        elif tag == "img":
            attributes = dict(attrs)
            alt = (attributes.get("alt") or "").strip()
            if alt:
                self.parts.append(f" [{alt}] ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag in {"script", "style", "nav"}:
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if self.skip_depth:
            return
        if re.fullmatch(r"h[1-6]", tag):
            self.heading_level = None
            self.parts.append("\n\n")
        elif tag == "li":
            self.in_list_item = False

    def handle_data(self, data: str) -> None:
        if self.skip_depth:
            return
        cleaned = " ".join(data.split())
        if cleaned:
            if self.parts and not self.parts[-1].endswith((" ", "\n")):
                self.parts.append(" ")
            self.parts.append(cleaned)

    def markdown(self) -> str:
        value = "".join(self.parts)
        value = re.sub(r"[ \t]+\n", "\n", value)
        value = re.sub(r"\n{3,}", "\n\n", value)
        return value.strip()


def extract_arxiv_html_text(content: bytes) -> bytes:
    parser = _StructuredHTMLExtractor()
    parser.feed(content.decode("utf-8", errors="replace"))
    text = parser.markdown()
    return (text + "\n").encode("utf-8") if text else b""


def _collapse(value: str | None) -> str:
    return " ".join((value or "").split())


def normalize_arxiv_input(value: str) -> NormalizedArxivInput:
    raw = value.strip()
    if not raw:
        raise ArxivImportError("请输入 arXiv 链接或 ID")
    candidate = re.sub(r"(?i)^arxiv:\s*", "", raw).strip()
    if "://" in candidate:
        try:
            parsed = urllib.parse.urlparse(candidate)
        except ValueError as exc:
            raise ArxivImportError("arXiv 链接格式无效") from exc
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in ARXIV_HOSTS:
            raise ArxivImportError("当前链接导入只支持 arxiv.org")
        path = urllib.parse.unquote(parsed.path).strip("/")
        if path.startswith("html/"):
            candidate = path[5:]
        elif path.startswith("abs/"):
            candidate = path[4:]
        elif path.startswith("pdf/"):
            candidate = path[4:]
            if candidate.casefold().endswith(".pdf"):
                candidate = candidate[:-4]
        else:
            raise ArxivImportError("arXiv 链接必须是 /abs/、/html/ 或 /pdf/ 地址")
    candidate = candidate.strip().rstrip("/")
    match = ARXIV_ID_PATTERN.fullmatch(candidate)
    if match is None:
        raise ArxivImportError("无法识别 arXiv ID，请检查输入格式")
    base_id = match.group("base")
    if "/" in base_id:
        archive, number = base_id.split("/", 1)
        base_id = f"{archive.casefold()}/{number}"
    return NormalizedArxivInput(
        base_id=base_id,
        requested_version=match.group("version").casefold() if match.group("version") else None,
        original_input=raw,
    )


def normalize_arxiv_link(value: str) -> NormalizedArxivInput:
    """The maintenance page accepts paper links, not bare identifiers."""
    try:
        parsed = urllib.parse.urlsplit(value.strip())
        allowed = (
            parsed.scheme in {"http", "https"}
            and parsed.hostname in ARXIV_HOSTS
            and not parsed.username
            and not parsed.password
            and parsed.port in {None, 80, 443}
        )
    except (AttributeError, ValueError):
        allowed = False
    if not allowed:
        raise ArxivImportError("目前只支持 arXiv 链接")
    try:
        return normalize_arxiv_input(value)
    except ArxivImportError as exc:
        raise ArxivImportError("请输入有效的 arXiv 论文链接（abs 或 pdf）。") from exc


def _read_official_url(url: str, *, max_bytes: int, accept: str) -> tuple[bytes, str]:
    parsed_request = urllib.parse.urlparse(url)
    if parsed_request.scheme != "https" or parsed_request.hostname not in ARXIV_HOSTS:
        raise ArxivImportError("arXiv 请求地址不受信任")
    request = urllib.request.Request(
        url,
        headers={
            "Accept": accept,
            "User-Agent": "AI-Persona/0.4 (+local personal archive)",
        },
    )
    default_paths = ssl.get_default_verify_paths()
    certificate_candidates = [
        default_paths.cafile,
        "/etc/ssl/cert.pem",
        "/etc/ssl/certs/ca-certificates.crt",
    ]
    certificate_file = next(
        (
            candidate
            for candidate in certificate_candidates
            if candidate and Path(candidate).is_file()
        ),
        None,
    )
    tls_context = ssl.create_default_context(cafile=certificate_file)
    opener = urllib.request.build_opener(
        _OfficialRedirectHandler(),
        urllib.request.HTTPSHandler(context=tls_context),
    )
    try:
        with opener.open(request, timeout=20) as response:
            content = response.read(max_bytes + 1)
            final_url = response.geturl()
    except (OSError, urllib.error.URLError, ValueError) as exc:
        raise ArxivImportError(f"无法读取 arXiv：{exc}") from exc
    if len(content) > max_bytes:
        raise ArxivImportError("arXiv 返回内容超过允许大小")
    parsed = urllib.parse.urlparse(final_url)
    if parsed.scheme != "https" or parsed.hostname not in ARXIV_HOSTS:
        raise ArxivImportError("arXiv 请求被重定向到不受信任的地址")
    return content, final_url


def _text(entry: ET.Element, path: str, namespaces: dict[str, str]) -> str | None:
    node = entry.find(path, namespaces)
    return node.text if node is not None else None


def fetch_arxiv_document(raw_input: str, *, prefer_html: bool = False) -> ArxivDocument:
    normalized = normalize_arxiv_input(raw_input)
    query_id = urllib.parse.quote(normalized.requested_id, safe="./")
    api_url = f"https://export.arxiv.org/api/query?id_list={query_id}"
    atom_xml, _ = _read_official_url(
        api_url,
        max_bytes=MAX_METADATA_BYTES,
        accept="application/atom+xml",
    )
    try:
        root = ET.fromstring(atom_xml)
    except ET.ParseError as exc:
        raise ArxivImportError("arXiv 返回了无法解析的元数据") from exc
    namespaces = {
        "atom": "http://www.w3.org/2005/Atom",
        "arxiv": "http://arxiv.org/schemas/atom",
    }
    entry = root.find("atom:entry", namespaces)
    if entry is None:
        if normalized.requested_version:
            raise ArxivImportError(f"arXiv 版本 {normalized.requested_version} 不存在")
        raise ArxivImportError("arXiv 中找不到该记录")

    entry_id = _collapse(_text(entry, "atom:id", namespaces))
    try:
        returned = normalize_arxiv_input(entry_id)
    except ArxivImportError as exc:
        raise ArxivImportError("arXiv 元数据缺少有效记录 ID") from exc
    if returned.base_id.casefold() != normalized.base_id.casefold():
        raise ArxivImportError("arXiv 返回的记录与请求 ID 不一致")
    if normalized.requested_version and returned.requested_version != normalized.requested_version:
        raise ArxivImportError("arXiv 返回的版本与指定版本不一致")
    version = normalized.requested_version or returned.requested_version
    if not version:
        raise ArxivImportError("arXiv 元数据缺少版本号")

    title = _collapse(_text(entry, "atom:title", namespaces))
    if not title:
        raise ArxivImportError("arXiv 元数据缺少标题")
    authors = [
        _collapse(_text(author, "atom:name", namespaces))
        for author in entry.findall("atom:author", namespaces)
    ]
    authors = [author for author in authors if author]
    abstract = _collapse(_text(entry, "atom:summary", namespaces))
    published = _collapse(_text(entry, "atom:published", namespaces))
    published_at = published[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", published) else None
    doi = _collapse(_text(entry, "arxiv:doi", namespaces)) or None
    venue = _collapse(_text(entry, "arxiv:journal_ref", namespaces)) or None
    categories = [
        value
        for node in entry.findall("atom:category", namespaces)
        if (value := _collapse(node.attrib.get("term")))
    ]

    pdf_url = f"https://arxiv.org/pdf/{normalized.base_id}{version}"
    pdf, final_pdf_url = b"", pdf_url
    if not prefer_html:
        pdf, final_pdf_url = _read_official_url(pdf_url, max_bytes=MAX_SOURCE_BYTES, accept="application/pdf")
        if not pdf.startswith(b"%PDF-"):
            raise ArxivImportError("arXiv 没有返回有效的 PDF 原文")
    html: bytes | None = None
    html_url: str | None = None
    extracted_text: bytes | None = None
    try:
        candidate_html, final_html_url = _read_official_url(
            f"https://arxiv.org/html/{normalized.base_id}{version}",
            max_bytes=MAX_SOURCE_BYTES,
            accept="text/html",
        )
        prefix = candidate_html[:1000].lower()
        if (b"<html" in prefix or b"<!doctype html" in prefix) and b"<article" in candidate_html.lower():
            candidate_text = extract_arxiv_html_text(candidate_html)
            if candidate_text:
                html = candidate_html
                html_url = final_html_url
                extracted_text = candidate_text
    except ArxivImportError:
        # HTML is a best-effort AI-friendly representation. PDF remains canonical.
        pass
    if prefer_html and not html:
        pdf, final_pdf_url = _read_official_url(pdf_url, max_bytes=MAX_SOURCE_BYTES, accept="application/pdf")
        if not pdf.startswith(b"%PDF-"):
            raise ArxivImportError("arXiv 没有返回可用的 HTML 或 PDF 原文")
    return ArxivDocument(
        normalized=normalized,
        version=version,
        title=title,
        authors=authors,
        abstract=abstract,
        published_at=published_at,
        venue=venue,
        doi=doi,
        categories=categories,
        pdf_url=final_pdf_url,
        atom_xml=atom_xml,
        pdf=pdf,
        html=html,
        html_url=html_url,
        extracted_text=extracted_text,
    )
