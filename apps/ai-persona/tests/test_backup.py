from __future__ import annotations

import io
import json
import sqlite3
import tarfile

import pytest

from ai_persona import backup, cli
from ai_persona.conversation_learning.contracts import LearningSettings, SourceConnection
from ai_persona.conversation_learning.repository import LearningRepository
from ai_persona.initialization import initialize_persona
from ai_persona.preference_application.repository import ApplicationRepository, ApplicationSettings
from ai_persona.store import PersonaStore


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_LEARNING_DIR", str(tmp_path / "learning"))
    monkeypatch.setenv("AI_PERSONA_CONFIG", str(tmp_path / "settings.toml"))
    root = tmp_path / "original"
    initialize_persona(root / "persona-data", root / "persona-state", persona_id="test-persona")
    with sqlite3.connect(root / "persona-state/ai-assistant.sqlite3") as db:
        db.execute("CREATE TABLE drafts (body TEXT)")
        db.execute("INSERT INTO drafts VALUES ('A private unfinished draft')")
    (root / "persona-state/prompts").mkdir()
    (root / "persona-state/prompts/version.json").write_text('{"version":3}')
    learning = LearningRepository(root / "persona-data")
    learning.save_settings(LearningSettings(enabled=True, allow_model_calls=True))
    learning.save_connection(SourceConnection(id="local", name="My app", enabled=True))
    applications = ApplicationRepository(root / "persona-state")
    applications.save_settings(ApplicationSettings(enabled=True))
    return root


def test_complete_roundtrip_keeps_records_drafts_and_external_learning(workspace, tmp_path):
    archive = tmp_path / "private.tar.gz"
    original = PersonaStore(workspace / "persona-data").load()
    result = backup.backup_workspace(workspace, archive)
    assert result["model_accounts_included"] is False
    assert archive.stat().st_mode & 0o777 == 0o600
    restored = tmp_path / "restored"
    result = backup.restore_workspace(archive, restored)
    assert result["automatic_features_enabled"] is False
    store = PersonaStore(restored / "persona-data").load()
    assert store.config == original.config
    assert set(store.records) == set(original.records)
    with sqlite3.connect(restored / "persona-state/ai-assistant.sqlite3") as db:
        assert db.execute("SELECT body FROM drafts").fetchone()[0] == "A private unfinished draft"
    assert (restored / "persona-state/prompts/version.json").read_text() == '{"version":3}'
    learning = LearningRepository(restored / "persona-data")
    assert not learning.settings().enabled and not learning.settings().allow_model_calls
    assert not learning.connection("local").enabled
    assert LearningRepository(workspace / "persona-data").settings().enabled
    assert not ApplicationRepository(restored / "persona-state").settings().enabled


def test_existing_backup_and_restore_targets_are_never_overwritten(workspace, tmp_path):
    archive = tmp_path / "backup.tar.gz"
    archive.write_text("keep")
    with pytest.raises(ValueError, match="already exists"):
        backup.backup_workspace(workspace, archive)
    assert archive.read_text() == "keep"
    with pytest.raises(ValueError, match="new workspace"):
        backup.restore_workspace(archive, workspace)
    with pytest.raises(ValueError, match="new destination"):
        backup.migrate_workspace(workspace, workspace)


def test_migration_preserves_source_and_never_changes_default(workspace, tmp_path):
    destination = tmp_path / "migrated"
    before = (workspace / "persona-data/config/persona.toml").read_bytes()
    result = backup.migrate_workspace(workspace, destination)
    assert result["source_preserved"]
    assert (workspace / "persona-data/config/persona.toml").read_bytes() == before
    assert not (tmp_path / "settings.toml").exists()


@pytest.mark.parametrize("name", ["../escape", "/tmp/escape", "persona-data/../../escape"])
def test_unsafe_archive_is_rejected_before_creating_target(tmp_path, name):
    archive = tmp_path / "bad.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        info = tarfile.TarInfo(name)
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    with pytest.raises(ValueError, match="unsafe"):
        backup.restore_workspace(archive, tmp_path / "restored")
    assert not (tmp_path / "restored").exists()


def test_corruption_is_rejected_and_rolls_back(workspace, tmp_path):
    archive = tmp_path / "backup.tar.gz"
    backup.backup_workspace(workspace, archive)
    corrupted = tmp_path / "corrupted.tar.gz"
    with tarfile.open(archive) as src, tarfile.open(corrupted, "w:gz") as dst:
        for member in src.getmembers():
            content = src.extractfile(member).read()
            if member.name == "manifest.json":
                manifest = json.loads(content)
                next(iter(manifest["files"].values()))["sha256"] = "invalid"
                content = json.dumps(manifest).encode()
                member.size = len(content)
            dst.addfile(member, io.BytesIO(content))
    with pytest.raises(ValueError, match="checksum"):
        backup.restore_workspace(corrupted, tmp_path / "restored")
    assert not (tmp_path / "restored").exists()


def test_symlinks_and_live_service_are_rejected(workspace, tmp_path, monkeypatch):
    link = workspace / "persona-state/external"
    link.symlink_to(tmp_path / "private")
    with pytest.raises(ValueError, match="symbolic"):
        backup.backup_workspace(workspace, tmp_path / "backup.tar.gz")
    link.unlink()
    marker = workspace / "persona-state/ui-server.json"
    marker.write_text('{"pid":123}')
    monkeypatch.setattr(backup, "_pid_is_running", lambda pid: True)
    with pytest.raises(ValueError, match="Stop Studio"):
        backup.backup_workspace(workspace, tmp_path / "backup.tar.gz")


def test_external_runtime_log_is_skipped_but_persistent_log_attachment_is_kept(workspace, tmp_path):
    external_log = tmp_path / "service.log"
    external_log.write_text("Runtime output")
    (workspace / "persona-state/ui-server.log").symlink_to(external_log)
    attachment = workspace / "persona-state/attachments/experiment.log"
    attachment.parent.mkdir()
    attachment.write_text("Keep this uploaded attachment")
    archive = tmp_path / "backup.tar.gz"
    backup.backup_workspace(workspace, archive)
    with tarfile.open(archive) as tar:
        assert "persona-state/ui-server.log" not in tar.getnames()
        assert tar.extractfile("persona-state/attachments/experiment.log").read() == b"Keep this uploaded attachment"


def test_failed_final_build_removes_only_new_destinations(workspace, tmp_path, monkeypatch):
    archive = tmp_path / "backup.tar.gz"
    backup.backup_workspace(workspace, archive)
    def fail(self):
        raise ValueError("simulated rebuild failure")
    monkeypatch.setattr(backup.PersonaCompiler, "build", fail)
    restored = tmp_path / "restored"
    with pytest.raises(ValueError, match="simulated"):
        backup.restore_workspace(archive, restored)
    assert not restored.exists()
    assert not backup.learning_directory(restored / "persona-data").exists()
    assert (workspace / "persona-data/config/persona.toml").exists()


def test_backup_cli_uses_the_same_verified_format(workspace, tmp_path, capsys):
    archive = tmp_path / "private.tar.gz"
    assert cli.main(["backup", "--workspace", str(workspace), "--output", str(archive)]) == 0
    assert json.loads(capsys.readouterr().out)["ok"]
    assert cli.main(["restore", str(archive), "--workspace", str(tmp_path / "new")]) == 0
    assert json.loads(capsys.readouterr().out)["automatic_features_enabled"] is False


@pytest.mark.parametrize("limit", ["MAX_FILES", "MAX_BYTES", "MAX_MANIFEST_BYTES"])
def test_backup_never_reports_success_for_an_archive_too_large_to_restore(workspace, tmp_path, monkeypatch, limit):
    monkeypatch.setattr(backup, limit, 1)
    archive = tmp_path / "too-large.tar.gz"
    with pytest.raises(ValueError, match="exceeds"):
        backup.backup_workspace(workspace, archive)
    assert not archive.exists()


@pytest.mark.parametrize('commit_change', [False, True])
def test_database_checkpoint_is_not_mistaken_for_content_change(workspace, tmp_path, monkeypatch, commit_change):
    from contextlib import closing

    path = workspace / 'persona-state/ai-assistant.sqlite3'
    snapshot = backup._snapshot_file
    with closing(sqlite3.connect(path)) as writer:
        writer.execute('PRAGMA journal_mode=WAL')
        writer.execute("INSERT INTO drafts VALUES ('New draft before backup')")
        writer.commit()

        def checkpoint(source, target, **kwargs):
            snapshot(source, target, **kwargs)
            if source == path and target.parent.name == 'persona-state':
                if commit_change:
                    writer.execute("INSERT INTO drafts VALUES ('Unexpected concurrent edit')")
                    writer.commit()
                else:
                    writer.execute('PRAGMA wal_checkpoint(TRUNCATE)')

        monkeypatch.setattr(backup, '_snapshot_file', checkpoint)
        archive = tmp_path / 'checkpoint.tar.gz'
        if commit_change:
            with pytest.raises(ValueError, match='changed'):
                backup.backup_workspace(workspace, archive)
            assert not archive.exists()
        else:
            backup.backup_workspace(workspace, archive)
            restored = tmp_path / 'checkpoint-restored'
            backup.restore_workspace(archive, restored)
            with closing(sqlite3.connect(restored/'persona-state/ai-assistant.sqlite3')) as db:
                assert db.execute('SELECT COUNT(*) FROM drafts').fetchone()[0] == 2
