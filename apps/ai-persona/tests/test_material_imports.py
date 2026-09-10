from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.index import search_index
from ai_persona.material_imports.arxiv import (
    extract_arxiv_html_text,
    normalize_arxiv_input,
)
from ai_persona.material_imports.markdown import parse_markdown
from ai_persona.material_imports.repository import ImportDraftRepository
from ai_persona.proposals import ProposalRepository
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def import_workspace(tmp_path: Path) -> tuple[Path, Path, TestClient]:
    demo = demo_workspace().data_root
    assert demo is not None
    data_root = tmp_path / "persona-data"
    shutil.copytree(demo, data_root)
    state_root = tmp_path / "persona-state"
    return data_root, state_root, TestClient(create_app(data_root, state_root))


def _material_form(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "material_type": "paper",
        "title": "Structured Paper",
        "aliases": "",
        "abstract": "A structured abstract for retrieval.",
        "authors": "Ada Lovelace\nGrace Hopper",
        "published_at": "2025-02-03",
        "venue": "Import Systems",
        "language": "en",
        "canonical_url": "https://example.test/paper",
        "arxiv": "",
        "doi": "10.1234/import-example",
        "isbn": "",
        "relationships": "read",
        "knowledge_level": "unspecified",
        "preference_level": "unspecified",
        "preference_reasons": "",
        "summary": "",
        "scope_note": "",
        "body": "",
        "reason": "Imported from a supplied source",
    }
    values.update(overrides)
    return values


def _draft_id(response: object) -> str:
    return response.headers["location"].rsplit("/", 1)[-1]  # type: ignore[attr-defined]


def _saved_proposal_id(response: object, data_root: Path) -> str:
    location = response.headers["location"]  # type: ignore[attr-defined]
    assert location.startswith("/materials/mat_") and "kind=success" in location
    repository = ProposalRepository(data_root)
    assert repository.list_pending() == []
    ledger = json.loads((data_root / "revisions/changes.jsonl").read_text().splitlines()[-1])
    proposal = repository.get(ledger["proposal_ids"][0])
    assert proposal.status == "accepted" and proposal.decision_source == "human_edit"
    return proposal.id


def _atom(version: str, *, title: str = "HTML-Friendly Paper") -> bytes:
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>https://arxiv.org/abs/2601.12345{version}</id>
    <title>{title}</title>
    <summary>An abstract supplied by the official Atom metadata.</summary>
    <published>2026-01-20T00:00:00Z</published>
    <author><name>Ada Lovelace</name></author>
    <author><name>Grace Hopper</name></author>
    <arxiv:doi>10.1234/arxiv-example</arxiv:doi>
    <arxiv:journal_ref>Journal of Structured Papers</arxiv:journal_ref>
    <category term="cs.AI" />
  </entry>
</feed>
""".encode()


def _install_fake_arxiv(monkeypatch: pytest.MonkeyPatch, version: str) -> None:
    def read(url: str, *, max_bytes: int, accept: str) -> tuple[bytes, str]:
        del max_bytes, accept
        if "/api/query" in url:
            return _atom(version), url
        if "/pdf/" in url:
            return b"%PDF-1.7\n" + version.encode() + b"\n%%EOF\n", url
        if "/html/" in url:
            html = b"""<!doctype html><html><body><article>
<h1>HTML-Friendly Paper</h1><section><h2>Method</h2>
<p>Semantic HTML paragraph for AI retrieval.</p></section></article></body></html>"""
            return html, url
        raise AssertionError(url)

    monkeypatch.setattr("ai_persona.material_imports.arxiv._read_official_url", read)


@pytest.mark.parametrize(
    ("raw", "base", "version"),
    [
        ("2401.12345", "2401.12345", None),
        ("arXiv:2401.12345v3", "2401.12345", "v3"),
        ("https://arxiv.org/abs/2401.12345v2", "2401.12345", "v2"),
        ("https://arxiv.org/pdf/hep-th/9901001v4.pdf", "hep-th/9901001", "v4"),
    ],
)
def test_arxiv_input_normalization(raw: str, base: str, version: str | None) -> None:
    normalized = normalize_arxiv_input(raw)
    assert normalized.base_id == base
    assert normalized.requested_version == version


def test_markdown_recognition_prefers_frontmatter_and_marks_heuristics() -> None:
    parsed = parse_markdown(
        b"""---
title: Frontmatter title
authors: [Ada Lovelace, Grace Hopper]
aliases: [Import paper]
date: 2025-02-03
doi: 10.1234/example
language: en
---
# Body title

## Abstract

The abstract is recognized from a section.
""",
        "paper.md",
    )
    assert parsed.values.title == "Frontmatter title"
    assert parsed.values.bibliography.authors == ["Ada Lovelace", "Grace Hopper"]
    assert parsed.values.abstract == "The abstract is recognized from a section."
    assert parsed.values.bibliography.identifiers.doi == "10.1234/example"
    assert parsed.field_states["title"].source == "markdown_frontmatter"
    assert parsed.field_states["abstract"].source == "markdown_section"


def test_arxiv_html_is_converted_to_structured_ai_text() -> None:
    extracted = extract_arxiv_html_text(
        b"<html><body><h1>Paper</h1><h2>Method</h2><p>First paragraph.</p>"
        b"<ul><li>Result one</li></ul><script>ignore()</script></body></html>"
    ).decode()
    assert "# Paper" in extracted
    assert "## Method" in extracted
    assert "First paragraph." in extracted
    assert "- Result one" in extracted
    assert "ignore" not in extracted


def test_markdown_two_stage_import_preserves_source_and_autofilled_abstract(
    import_workspace: tuple[Path, Path, TestClient],
) -> None:
    data_root, state_root, client = import_workspace
    markdown = b"""---
title: Structured Paper
authors:
  - Ada Lovelace
  - Grace Hopper
abstract: A structured abstract for retrieval.
date: 2025-02-03
venue: Import Systems
language: en
doi: 10.1234/import-example
url: https://example.test/paper
---
# Structured Paper

Original Markdown body.
"""
    preview = client.post(
        "/materials/import-preview",
        data={"input_kind": "markdown"},
        files={"markdown_file": ("structured.md", markdown, "text/markdown")},
        follow_redirects=False,
    )
    assert preview.status_code == 303
    draft_id = _draft_id(preview)
    page = client.get(preview.headers["location"])
    assert page.status_code == 200
    assert all(
        text in page.text
        for text in [
            "Structured Paper",
            "Ada Lovelace",
            "A structured abstract for retrieval.",
            "自动填入",
        ]
    )
    assert 'name="relationships" value="read" checked' not in page.text
    assert 'name="preference_level"' in page.text
    assert 'value="unspecified" selected' in page.text

    created = client.post(
        f"/materials/imports/{draft_id}/proposals",
        data=_material_form(),
        follow_redirects=False,
    )
    assert created.status_code == 303
    assert not (state_root / "material-imports" / draft_id).exists()
    proposal_id = _saved_proposal_id(created, data_root)
    proposal = ProposalRepository(data_root).get(proposal_id)
    patches = {item.field: item.after for item in proposal.patch}
    assert patches["abstract"] == "A structured abstract for retrieval."
    source_id = str(patches["source_ref"])
    staged = data_root / "sources" / source_id
    assert (staged / "original.md").read_bytes() == markdown
    metadata = json.loads((staged / "attachments" / "metadata.json").read_text())
    assert metadata["field_states"]["title"]["source"] == "markdown_frontmatter"

    store = PersonaStore(data_root).load()
    material = store.records[proposal.target_id].record
    assert material.abstract == "A structured abstract for retrieval."  # type: ignore[attr-defined]
    assert store.source_file_path(source_id, "original.md").read_bytes() == markdown
    detail = client.get(f"/materials/{proposal.target_id}")
    assert "A structured abstract for retrieval." in detail.text
    assert search_index(state_root, "structured abstract")[0]["id"] == proposal.target_id


def test_arxiv_import_keeps_pdf_and_prefers_html_text_for_ai(
    import_workspace: tuple[Path, Path, TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    data_root, state_root, client = import_workspace
    _install_fake_arxiv(monkeypatch, "v1")
    preview = client.post(
        "/materials/import-preview",
        data={"input_kind": "arxiv", "arxiv_input": "2601.12345v1"},
        follow_redirects=False,
    )
    assert preview.status_code == 303
    draft_id = _draft_id(preview)
    repository = ImportDraftRepository(state_root)
    draft = repository.get(draft_id)
    roles = {item.path: item.role for item in draft.files}
    assert roles["original.pdf"] == "original"
    assert roles["attachments/arxiv.html"] == "attachment"
    assert roles["attachments/extracted.md"] == "extracted_text"

    form = _material_form(
        title="HTML-Friendly Paper",
        abstract="An abstract supplied by the official Atom metadata.",
        authors="Ada Lovelace\nGrace Hopper",
        published_at="2026-01-20",
        venue="Journal of Structured Papers",
        canonical_url="https://arxiv.org/abs/2601.12345",
        arxiv="2601.12345",
        doi="10.1234/arxiv-example",
        relationships="studied",
        knowledge_level="familiar",
        preference_level="liked",
        summary="My durable personal summary",
    )
    created = client.post(
        f"/materials/imports/{draft_id}/proposals", data=form, follow_redirects=False
    )
    proposal_id = _saved_proposal_id(created, data_root)
    saved = ProposalRepository(data_root).get(proposal_id)
    store = PersonaStore(data_root).load()
    manifest = store.sources[store.records[saved.target_id].record.source_ref]  # type: ignore[attr-defined]
    assert manifest.canonical_file == "original.pdf"
    assert manifest.origin.version == "v1"
    preferred = next(item for item in manifest.files if item.role == "extracted_text")
    assert preferred.path == "attachments/extracted.md"
    assert "Semantic HTML paragraph" in store.source_file_path(
        manifest.id, preferred.path
    ).read_text()


def test_new_arxiv_version_updates_source_facts_but_preserves_personal_fields(
    import_workspace: tuple[Path, Path, TestClient], monkeypatch: pytest.MonkeyPatch
) -> None:
    data_root, state_root, client = import_workspace
    _install_fake_arxiv(monkeypatch, "v1")
    first = client.post(
        "/materials/import-preview",
        data={"input_kind": "arxiv", "arxiv_input": "2601.12345v1"},
        follow_redirects=False,
    )
    first_form = _material_form(
        title="HTML-Friendly Paper",
        abstract="An abstract supplied by the official Atom metadata.",
        authors="Ada Lovelace\nGrace Hopper",
        published_at="2026-01-20",
        venue="Journal of Structured Papers",
        canonical_url="https://arxiv.org/abs/2601.12345",
        arxiv="2601.12345",
        doi="10.1234/arxiv-example",
        relationships="studied",
        knowledge_level="familiar",
        preference_level="liked",
        summary="Keep this personal summary",
    )
    created = client.post(
        f"/materials/imports/{_draft_id(first)}/proposals",
        data=first_form,
        follow_redirects=False,
    )
    first_saved = ProposalRepository(data_root).get(_saved_proposal_id(created, data_root))

    _install_fake_arxiv(monkeypatch, "v2")
    second = client.post(
        "/materials/import-preview",
        data={"input_kind": "arxiv", "arxiv_input": "2601.12345v2"},
        follow_redirects=False,
    )
    second_page = client.get(second.headers["location"])
    assert "发现新版本" in second_page.text
    version_form = {
        key: value
        for key, value in first_form.items()
        if key
        in {
            "material_type",
            "title",
            "aliases",
            "abstract",
            "authors",
            "published_at",
            "venue",
            "language",
            "canonical_url",
            "arxiv",
            "doi",
            "isbn",
            "reason",
        }
    }
    updated = client.post(
        f"/materials/imports/{_draft_id(second)}/version-proposals",
        data=version_form,
        follow_redirects=False,
    )
    assert updated.status_code == 303
    proposal = ProposalRepository(data_root).get(_saved_proposal_id(updated, data_root))
    assert proposal.target_id == first_saved.target_id

    material = PersonaStore(data_root).load().records[proposal.target_id].record
    assert material.user_relationships == ["studied"]  # type: ignore[attr-defined]
    assert material.knowledge_level == "familiar"  # type: ignore[attr-defined]
    assert material.preference_level == "liked"  # type: ignore[attr-defined]
    assert material.summary == "Keep this personal summary"  # type: ignore[attr-defined]
    source = PersonaStore(data_root).load().sources[material.source_ref]  # type: ignore[attr-defined]
    assert source.origin.version == "v2"


def test_exact_markdown_duplicate_is_stopped_before_proposal(
    import_workspace: tuple[Path, Path, TestClient],
) -> None:
    data_root, state_root, client = import_workspace
    markdown = b"# Same bytes\n\n## Abstract\n\nDuplicate check.\n"
    first = client.post(
        "/materials/import-preview",
        data={"input_kind": "markdown"},
        files={"markdown_file": ("same.md", markdown, "text/markdown")},
        follow_redirects=False,
    )
    first_form = _material_form(
        material_type="note",
        title="Same bytes",
        abstract="Duplicate check.",
        authors="",
        published_at="",
        venue="",
        language="en",
        canonical_url="",
        doi="",
    )
    created = client.post(
        f"/materials/imports/{_draft_id(first)}/proposals",
        data=first_form,
        follow_redirects=False,
    )
    _saved_proposal_id(created, data_root)
    proposal_count = len(ProposalRepository(data_root).list_pending())

    duplicate = client.post(
        "/materials/import-preview",
        data={"input_kind": "markdown"},
        files={"markdown_file": ("same.md", markdown, "text/markdown")},
        follow_redirects=False,
    )
    page = client.get(duplicate.headers["location"])
    assert "相同材料" in page.text
    blocked = client.post(
        f"/materials/imports/{_draft_id(duplicate)}/proposals",
        data=first_form,
        follow_redirects=False,
    )
    assert blocked.status_code == 422
    assert len(ProposalRepository(data_root).list_pending()) == proposal_count


def test_failed_import_save_cleans_its_unpublished_source(
    import_workspace: tuple[Path, Path, TestClient], monkeypatch: pytest.MonkeyPatch,
) -> None:
    data_root, state_root, client = import_workspace
    preview = client.post(
        "/materials/import-preview",
        data={"input_kind": "markdown"},
        files={
            "markdown_file": (
                "reject-me.md",
                b"# Reject me\n\n## Abstract\n\nTemporary source.\n",
                "text/markdown",
            )
        },
        follow_redirects=False,
    )
    from ai_persona.compiler import PersonaCompiler
    from ai_persona.proposals import ProposalError

    original_build = PersonaCompiler.build
    attempts = 0

    def fail_once(compiler):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise ProposalError("Simulated publication failure")
        return original_build(compiler)

    monkeypatch.setattr(PersonaCompiler, "build", fail_once)
    before = PersonaStore(data_root).load()
    before_history = ProposalRepository(data_root).list_history()
    created = client.post(
        f"/materials/imports/{_draft_id(preview)}/proposals",
        data=_material_form(
            material_type="note",
            title="Reject me",
            abstract="Temporary source.",
            authors="",
            published_at="",
            venue="",
            language="en",
            canonical_url="",
            doi="",
        ),
        follow_redirects=False,
    )
    assert created.status_code == 422
    assert "Simulated publication failure" in created.text
    after = PersonaStore(data_root).load()
    assert set(after.records) == set(before.records)
    assert set(after.sources) == set(before.sources)
    assert after.config.revision == before.config.revision
    assert ProposalRepository(data_root).list_pending() == []
    assert ProposalRepository(data_root).list_history() == before_history
    assert not list((data_root / "sources" / ".staging").glob("src_*"))
    assert (state_root / "material-imports" / _draft_id(preview)).exists()
