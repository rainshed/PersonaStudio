"""Task-owned immutable sources. Saving an attachment does not create a Material."""

from __future__ import annotations

from pathlib import Path

from ..agent import AgentServiceError
from ..change_sets import proposal_lock
from ..materials import publish_staged_source, stage_source


def save_text(data_root, state_root, *, text, title, kind):
    if not isinstance(text, str) or not text.strip() or len(text.encode()) > 750_000:
        raise AgentServiceError("invalid_request", "请提供非空 UTF-8 文本（最多 750 KB）。")
    title = Path(title or "参考文本.txt").name[:200]
    if Path(title).suffix.lower() not in {".txt", ".md", ".markdown"}:
        raise AgentServiceError("unsupported_file", "目前支持 Markdown 和 UTF-8 TXT 文件。")
    staged = stage_source(
        data_root,
        content=text.encode(),
        filename=title,
        source_type="manual_declaration" if kind == "user_statement" else "task_attachment",
        provider="maintenance-" + kind,
        media_type="text/markdown",
    )
    with proposal_lock(state_root):
        publish_staged_source(data_root, staged.manifest.id)
    return {
        "id": staged.manifest.id,
        "title": title,
        "kind": kind,
        "source_hash": "sha256:" + staged.manifest.content_hash,
        "file": staged.manifest.canonical_file,
        "lines": len(text.splitlines()),
    }
