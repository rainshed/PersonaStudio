"""Immutable originals and bounded, addressable reading blocks."""

from __future__ import annotations

import hashlib
import re
import textwrap
from pathlib import Path

from bs4 import BeautifulSoup

from ..agent import AgentServiceError
from ..change_sets import proposal_lock
from ..material_imports.arxiv import fetch_arxiv_document
from ..materials import SourceAttachment, publish_staged_source, stage_source
from ..store import PersonaStore

TEXT_FILE = "attachments/structured.md"
MAX_UPLOAD = 20 * 1024 * 1024


def lines_for(text):
    # Long paragraphs are wrapped, never cut off. Stable line addresses belong to this rendition.
    return [
        part
        for line in text.replace("\x00", "").splitlines()
        for part in (
            textwrap.wrap(line, width=240, replace_whitespace=False, drop_whitespace=False) or [""]
        )
    ]


def parse_html(content):
    soup = BeautifulSoup(content, "html.parser")
    root = soup.find("article")
    if root is None:
        raise AgentServiceError("invalid_html", "HTML 缺少论文正文，不能把错误页面作为材料。")
    for node in root.select("script,style,nav,footer,.ltx_page_footer"):
        node.decompose()
    for node in root.find_all("math"):
        annotation = node.find("annotation", attrs={"encoding": "application/x-tex"})
        node.replace_with(
            " $"
            + (
                node.get("alttext")
                or (annotation.get_text() if annotation else node.get_text(" ", strip=True))
            )
            + "$ "
        )
    for node in root.find_all("img"):
        node.replace_with(" [图像：" + (node.get("alt") or "需查看原文") + "] ")
    lines, sections = [], []
    for node in root.find_all(
        ["h1", "h2", "h3", "h4", "h5", "h6", "p", "figcaption", "table", "li", "div"]
    ):
        if node.name == "div" and not any(
            c in node.get("class", []) for c in ["ltx_equation", "ltx_equationgroup"]
        ):
            continue
        if node.find_parent(["p", "figcaption", "table", "li"]):
            continue
        text = node.get_text(" ", strip=True)
        if not text:
            continue
        if re.fullmatch("h[1-6]", node.name):
            parent = node.find_parent("section")
            sections.append(
                {
                    "title": text,
                    "start": len(lines) + 1,
                    "anchor": node.get("id") or (parent.get("id") if parent else None),
                }
            )
            text = "#" * int(node.name[1]) + " " + text
        lines.extend(lines_for(text) + [""])
    return finish_index(lines, sections), []


def finish_index(lines, sections):
    if not sections or sections[0]["start"] != 1:
        sections.insert(0, {"title": "开头", "start": 1})
    for i, section in enumerate(sections):
        section["end"] = sections[i + 1]["start"] - 1 if i + 1 < len(sections) else len(lines)
    if not any(line.strip() for line in lines):
        raise AgentServiceError("empty_source", "材料没有可读取的文本。")
    if len("\n".join(lines).encode()) > 8 * 1024 * 1024:
        raise AgentServiceError("source_too_large", "解析后的文本超过 8 MB，请分卷上传。")
    return {"text": "\n".join(lines) + "\n", "sections": sections, "line_count": len(lines)}


def parse_file(content, filename):
    suffix = Path(filename).suffix.lower()
    if suffix == ".pdf":
        import pypdfium2 as pdfium

        from ..query_sources import _pdf_lock

        if not content.startswith(b"%PDF-"):
            raise AgentServiceError("invalid_pdf", "文件内容不是有效 PDF。")
        lines, sections, warnings = [], [], []
        with _pdf_lock:
            document = pdfium.PdfDocument(content)
            try:
                if len(document) > 500:
                    raise AgentServiceError("source_too_large", "PDF 超过 500 页，请分卷上传。")
                for i in range(len(document)):
                    page = document[i]
                    textpage = page.get_textpage()
                    try:
                        text = textpage.get_text_range()
                    finally:
                        textpage.close()
                        page.close()
                    sections.append(
                        {"title": f"第 {i + 1} 页", "page": i + 1, "start": len(lines) + 1}
                    )
                    lines.append(f"## 第 {i + 1} 页")
                    if len(text.strip()) < 20:
                        warnings.append(
                            f"第 {i + 1} 页文本不足，可能包含扫描图、图表或公式，需核对原页。"
                        )
                    lines.extend(lines_for(text) + [""])
            finally:
                document.close()
        return finish_index(lines, sections), warnings
    if suffix not in {".md", ".markdown", ".txt"}:
        raise AgentServiceError("unsupported_file", "请上传 Markdown、TXT 或 PDF 文件。")
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise AgentServiceError("invalid_encoding", "请将文本另存为 UTF-8 后上传。") from exc
    lines = lines_for(text)
    sections = [
        {"title": line.lstrip("# "), "start": i + 1}
        for i, line in enumerate(lines)
        if re.match(r"^#{1,6}\s", line)
    ]
    return finish_index(lines, sections), []


def import_source(data_root, state_root, *, filename=None, content=None, arxiv=None):
    metadata, attachments = {}, []
    identifier = version = url = None
    if arxiv:
        doc = fetch_arxiv_document(arxiv, prefer_html=True)
        identifier, version = doc.normalized.base_id, doc.version
        url = f"https://arxiv.org/abs/{identifier}{version}"
        if doc.html:
            content, filename, media = doc.html, "paper.html", "text/html"
            index, warnings = parse_html(content)
        else:
            content, filename, media = doc.pdf, "paper.pdf", "application/pdf"
            index, warnings = parse_file(content, filename)
            warnings.insert(0, "arXiv HTML 不可用，已使用 PDF。")
        title = doc.title
        metadata = {
            "title": title,
            "material_type": "paper",
            "abstract": doc.abstract,
            "bibliography": {
                "authors": doc.authors,
                "published_at": doc.published_at,
                "venue": doc.venue,
                "canonical_url": url,
                "identifiers": {"arxiv": identifier + version, "doi": doc.doi},
            },
        }
        # Bibliographic metadata is also a source attachment, so it can be cited precisely.
        header = lines_for(
            f"# {title}\nAuthors: {', '.join(doc.authors)}\nURL: {url}\nPublished: {doc.published_at or ''}\n\n{doc.abstract}\n\n"
        )
        for section in index["sections"]:
            section["start"] += len(header)
            section["end"] += len(header)
        index["sections"].insert(0, {"title": "书目信息与摘要", "start": 1, "end": len(header)})
        index["text"] = "\n".join(header) + "\n" + index["text"]
        index["line_count"] += len(header)
        attachments.append(SourceAttachment("metadata.xml", doc.atom_xml, "application/atom+xml"))
    else:
        if not content or len(content) > MAX_UPLOAD:
            raise AgentServiceError("invalid_file", "文件不能为空，每个文件最大 20 MB。")
        filename = Path(filename or "material.md").name
        index, warnings = parse_file(content, filename)
        media = "application/pdf" if filename.lower().endswith(".pdf") else "text/markdown"
        title = next(
            (s["title"] for s in index["sections"] if s["title"] != "开头" and not s.get("page")),
            Path(filename).stem,
        )
        metadata = {"title": title, "material_type": "note", "bibliography": {}}
    digest = hashlib.sha256(content).hexdigest()
    identity = f"arxiv:{identifier}{version}" if identifier else "sha256:" + digest
    attachments.append(
        SourceAttachment(
            "structured.md", index.pop("text").encode(), "text/markdown", "extracted_text"
        )
    )
    # A duplicate rendition reuses its original source, without counting it as another paper.
    with proposal_lock(state_root):
        store = PersonaStore(data_root).load()
        existing = next(
            (
                s
                for s in store.sources.values()
                if s.content_hash == digest and any(f.path == TEXT_FILE for f in s.files)
            ),
            None,
        )
        if existing:
            source_id = existing.id
        else:
            staged = stage_source(
                data_root,
                content=content,
                filename=filename,
                source_type="paper" if arxiv else "task_attachment",
                provider="arxiv" if arxiv else "local",
                media_type=media,
                identifier=identifier,
                version=version,
                url=url,
                attachments=attachments,
            )
            publish_staged_source(data_root, staged.manifest.id)
            source_id = staged.manifest.id
    return dict(
        source_id=source_id,
        identity=identity,
        hash=digest,
        title=title,
        filename=filename,
        metadata=metadata,
        url=url,
        version=version,
        index=index,
        warnings=warnings,
        status="ready",
        analysis=None,
        error=None,
        removed=False,
    )
