"""Backups preserve immutable originals and the sources of unfinished reviews."""
import hashlib
import sqlite3

import pytest

from ai_persona.backup import backup_workspace, restore_workspace
from ai_persona.initialization import initialize_persona
from ai_persona.materials import SourceAttachment, stage_source, validate_staged_source
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.store import PersonaStore


@pytest.fixture
def source_workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "learning"))
    root = tmp_path / "original"
    initialize_persona(root / "persona-data", root / "persona-state", persona_id="source-test")
    return root


def material_proposal(workspace, source_id):
    return ProposalService(workspace / "persona-data", workspace / "persona-state").create_record(
        "material", {
            "material_type": "other", "title": "Uploaded research material",
            "bibliography": {}, "user_relationships": ["read"],
            "preference_level": "unspecified", "source_ref": source_id,
        }, submitted_by="ai", reason="Review the user-provided research material.",
    )


def test_uploaded_sqlite_source_and_cache_like_attachment_names_remain_byte_identical(
    source_workspace, tmp_path,
):
    root = source_workspace
    original = tmp_path / "uploaded.sqlite3"
    with sqlite3.connect(original) as db:
        db.execute("CREATE TABLE measurements (value TEXT)")
        db.execute("INSERT INTO measurements VALUES ('Original research sample')")
    source_bytes = original.read_bytes()
    staged = stage_source(
        root / "persona-data", content=source_bytes, filename="measurements.sqlite3",
        source_type="other", provider="test-user-upload", media_type="application/octet-stream",
        attachments=[
            SourceAttachment(filename="experiment.log", content=b"Original experiment output", media_type="text/plain"),
            SourceAttachment(filename=".lock", content=b"An immutable uploaded file", media_type="application/octet-stream"),
        ],
    )
    proposal = material_proposal(root, staged.manifest.id)
    ProposalService(root / "persona-data", root / "persona-state").accept(proposal.id)
    source_store = PersonaStore(root / "persona-data").load()
    originals = {item.path: source_store.source_file_path(staged.manifest.id, item.path).read_bytes()
                 for item in staged.manifest.files}
    archive = tmp_path / "private.tar.gz"
    backup_workspace(root, archive)
    restored = tmp_path / "restored"
    restore_workspace(archive, restored)
    restored_store = PersonaStore(restored / "persona-data").load()
    assert restored_store.sources[staged.manifest.id] == source_store.sources[staged.manifest.id]
    for path, content in originals.items():
        assert restored_store.source_file_path(staged.manifest.id, path).read_bytes() == content
        assert source_store.source_file_path(staged.manifest.id, path).read_bytes() == content
    assert hashlib.sha256(source_bytes).hexdigest() == staged.manifest.content_hash


def test_pending_material_retains_staged_source_and_can_be_accepted_after_restore(
    source_workspace, tmp_path,
):
    root = source_workspace
    content = b"# User research notes\nPreserve this unfinished review.\n"
    staged = stage_source(
        root / "persona-data", content=content, filename="notes.md",
        source_type="other", provider="test-user-upload", media_type="text/markdown",
    )
    proposal = material_proposal(root, staged.manifest.id)
    original_revision = PersonaStore(root / "persona-data").load().config.revision
    archive = tmp_path / "pending.tar.gz"
    backup_workspace(root, archive)
    restored = tmp_path / "restored"
    restore_workspace(archive, restored)
    restored_staged = validate_staged_source(restored / "persona-data", staged.manifest.id)
    assert restored_staged.manifest == staged.manifest
    assert (restored_staged.path / staged.manifest.canonical_file).read_bytes() == content
    assert ProposalRepository(restored / "persona-data").get(proposal.id).status == "pending_review"
    ProposalService(restored / "persona-data", restored / "persona-state").accept(proposal.id)
    restored_store = PersonaStore(restored / "persona-data").load()
    assert restored_store.records[proposal.target_id].record.source_ref == staged.manifest.id
    assert restored_store.source_file_path(staged.manifest.id, staged.manifest.canonical_file).read_bytes() == content
    # Accepting the restored candidate must not touch the original pending review.
    assert ProposalRepository(root / "persona-data").get(proposal.id).status == "pending_review"
    assert PersonaStore(root / "persona-data").load().config.revision == original_revision
    assert (staged.path / staged.manifest.canonical_file).read_bytes() == content
