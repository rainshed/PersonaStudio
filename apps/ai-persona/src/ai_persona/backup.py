"""Portable private workspace backups, verified before publishing to a new location.

Canonical records, source bundles, drafts, evaluations, prompts and the external
learning repository travel together. Machine-wide model accounts never do.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from .compiler import PersonaCompiler
from .conversation_learning.contracts import digest
from .demo import is_demo_data
from .launcher import _pid_is_running
from .store import PersonaStore

SCHEMA = "ai-persona.workspace-backup/v1"
ROOTS = {"persona-data", "persona-state", "conversation-learning"}
MAX_FILES = 100_000
MAX_BYTES = 20 * 1024**3
MAX_MANIFEST_BYTES = 16 * 1024**2
SQLITE_DATABASES = {
    "persona-state/persona.sqlite3", "persona-state/ai-assistant.sqlite3",
    "persona-state/preference-applications.sqlite3", "persona-state/prompts/prompts.sqlite3",
    "conversation-learning/conversation-learning.sqlite3",
}
TRANSIENT_PATHS = {
    "persona-state/ui-server.json", "persona-state/ui-server.log", "persona-state/ui-server-start.lock",
    "conversation-learning/worker.json", "conversation-learning/worker.lock",
    "conversation-learning/worker.log", "conversation-learning/stop.request",
}


def learning_directory(data_root: Path) -> Path:
    base = Path(os.environ.get(
        "AI_PERSONA_LEARNING_DIR", str(Path.home() / ".local/share/ai-persona/learning")
    )).expanduser()
    return base / digest(str(data_root.resolve()))[:32]


def _assert_stopped(workspace: Path, learning: Path) -> None:
    marker = workspace / "persona-state/ui-server.json"
    if marker.is_file():
        try:
            pid = int(json.loads(marker.read_text())["pid"])
        except (ValueError, KeyError, TypeError):
            raise ValueError("Cannot verify Studio status; check ai-persona status first.") from None
        if _pid_is_running(pid):
            raise ValueError("Stop Studio before backing up: ai-persona stop --workspace PATH")
    lock = learning / "worker.lock"
    if lock.exists():
        with lock.open("rb") as stream:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("Stop the learning worker before backing up.") from None
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)


def _files(root: Path, name: str):
    if root.is_symlink():
        raise ValueError(f"Backup does not follow symbolic links: {root}")
    if not root.exists():
        return []
    files = []
    for path in root.rglob("*"):
        if _skip(name, path.relative_to(root)):
            continue
        if path.is_symlink():
            raise ValueError(f"Backup does not follow symbolic links: {path}")
        if path.is_file():
            files.append(path)
    return sorted(files)


def _signature(roots: dict[str, Path]) -> dict:
    return {
        f"{name}/{p.relative_to(root).as_posix()}": (p.stat().st_size, p.stat().st_mtime_ns)
        for name, root in roots.items() for p in _files(root, name)
    }


def _skip(name: str, relative: Path) -> bool:
    # Pending proposals still reference sources/.staging. Every canonical or
    # staged original must survive, including filenames that resemble caches.
    if name == "persona-data":
        return False
    path = f"{name}/{relative.as_posix()}"
    return path in TRANSIENT_PATHS or any(path in {db + "-wal", db + "-shm"} for db in SQLITE_DATABASES)


def _snapshot_file(source: Path, target: Path, *, sqlite_snapshot: bool = False) -> None:
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if sqlite_snapshot:
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as src:
            with sqlite3.connect(target) as dst:
                src.backup(dst)
                if dst.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise ValueError(f"Invalid database: {source.name}")
    else:
        shutil.copyfile(source, target)
    target.chmod(0o600)


def backup_workspace(workspace: Path, output: Path, *, learning_dir: Path | None = None) -> dict:
    workspace = workspace.expanduser().resolve()
    output = output.expanduser().absolute()
    data = workspace / "persona-data"
    if is_demo_data(data):
        raise ValueError("Use a real workspace for migration backups; Demo has its own isolated copy.")
    learning = (learning_dir or learning_directory(data)).expanduser().resolve()
    roots = {"persona-data": data, "persona-state": workspace / "persona-state",
             "conversation-learning": learning}
    if any(root == output.resolve() or root in output.resolve().parents for root in roots.values()):
        raise ValueError("Save backups outside the workspace and learning directories.")
    if output.exists() or output.is_symlink():
        raise ValueError("Backup destination already exists; choose a new filename.")
    for name, root in roots.items():
        _files(root, name)
    _assert_stopped(workspace, learning)
    store = PersonaStore(data).load()
    before = _signature(roots)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="persona-backup-") as tmp:
        staged = Path(tmp)
        manifest = {"schema": SCHEMA, "created_at": datetime.now(UTC).isoformat(),
                    "persona_id": store.config.persona_id, "persona_revision": store.config.revision,
                    "record_count": len(store.records), "source_count": len(store.sources),
                    "model_accounts_included": False, "files": {}}
        for name, root in roots.items():
            for source in _files(root, name):
                relative = source.relative_to(root)
                if _skip(name, relative):
                    continue
                path = f"{name}/{relative.as_posix()}"
                target = staged / path
                is_database = path in SQLITE_DATABASES
                _snapshot_file(source, target, sqlite_snapshot=is_database)
                with target.open("rb") as content:
                    checksum = hashlib.file_digest(content, "sha256").hexdigest()
                manifest["files"][path] = {"sha256": checksum, "size": target.stat().st_size}
        if before != _signature(roots):
            raise ValueError("Workspace changed during backup. Close writing clients and retry.")
        manifest_bytes = json.dumps(manifest, indent=2).encode("utf-8")
        payload_size = sum(entry["size"] for entry in manifest["files"].values())
        if (len(manifest["files"]) + 1 > MAX_FILES
                or payload_size + len(manifest_bytes) > MAX_BYTES
                or len(manifest_bytes) > MAX_MANIFEST_BYTES):
            raise ValueError("Workspace exceeds the supported backup size or file count.")
        (staged / "manifest.json").write_bytes(manifest_bytes)
        # Exclusive creation protects an existing backup even if another process raced us.
        with output.open("xb") as stream:
            output.chmod(0o600)
            try:
                with tarfile.open(fileobj=stream, mode="w:gz") as archive:
                    for path in sorted(p for p in staged.rglob("*") if p.is_file()):
                        info = archive.gettarinfo(str(path), arcname=path.relative_to(staged).as_posix())
                        info.uid = info.gid = 0
                        info.uname = info.gname = ""
                        info.mode = 0o600
                        with path.open("rb") as content:
                            archive.addfile(info, content)
            except BaseException:
                output.unlink(missing_ok=True)
                raise
    return {"ok": True, "archive": str(output), "files": len(manifest["files"]),
            "persona_revision": manifest["persona_revision"], "model_accounts_included": False}


def _extract_verified(archive: Path, staged: Path) -> dict:
    with tarfile.open(archive, "r:gz") as tar:
        members, total = [], 0
        for member in tar:
            members.append(member)
            total += member.size
            if len(members) > MAX_FILES or total > MAX_BYTES:
                raise ValueError("Backup exceeds the supported size or file count.")
        seen = set()
        for member in members:
            path = PurePosixPath(member.name)
            if (not member.isfile() or member.name in seen or path.is_absolute()
                    or ".." in path.parts or "\\" in member.name
                    or path.as_posix() != member.name
                    or (member.name != "manifest.json" and (not path.parts or path.parts[0] not in ROOTS))):
                raise ValueError("Backup contains an unsafe, duplicate or unexpected path.")
            seen.add(member.name)
        if "manifest.json" not in seen or tar.getmember("manifest.json").size > MAX_MANIFEST_BYTES:
            raise ValueError("Backup manifest is missing or too large.")
        manifest = json.load(tar.extractfile("manifest.json"))
        if (not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA
                or not isinstance(manifest.get("files"), dict)):
            raise ValueError("Unsupported backup format.")
        if any(key not in manifest for key in (
            "persona_id", "persona_revision", "record_count", "source_count"
        )) or any(not isinstance(entry, dict) for entry in manifest["files"].values()):
            raise ValueError("Invalid backup manifest.")
        if set(manifest["files"]) != seen - {"manifest.json"}:
            raise ValueError("Backup file list does not match its manifest.")
        for member in members:
            if member.name == "manifest.json":
                continue
            target = staged / member.name
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            with tar.extractfile(member) as src, target.open("xb") as dst:
                shutil.copyfileobj(src, dst)
            target.chmod(0o600)
            entry = manifest["files"][member.name]
            with target.open("rb") as content:
                checksum = hashlib.file_digest(content, "sha256").hexdigest()
            if entry.get("size") != member.size or entry.get("sha256") != checksum:
                raise ValueError(f"Backup checksum failed: {member.name}")
    return manifest


def _disable_integrations(staged: Path) -> None:
    learning = staged / "conversation-learning/conversation-learning.sqlite3"
    if learning.is_file():
        with sqlite3.connect(learning) as db:
            row = db.execute("SELECT value FROM config WHERE key='settings'").fetchone()
            if row:
                value = json.loads(row[0])
                value.update(enabled=False, allow_model_calls=False)
                db.execute("UPDATE config SET value=? WHERE key='settings'", (json.dumps(value),))
            for identifier, body in db.execute("SELECT id,value FROM connections").fetchall():
                value = json.loads(body)
                value.update(enabled=False, trust_user_messages=False)
                db.execute("UPDATE connections SET value=? WHERE id=?", (json.dumps(value), identifier))
    applications = staged / "persona-state/preference-applications.sqlite3"
    if applications.is_file():
        with sqlite3.connect(applications) as db:
            row = db.execute("SELECT body FROM settings WHERE id=1").fetchone()
            if row:
                value = json.loads(row[0])
                value["enabled"] = False
                db.execute("UPDATE settings SET body=? WHERE id=1", (json.dumps(value),))


def restore_workspace(archive: Path, workspace: Path) -> dict:
    workspace = workspace.expanduser().absolute()
    if workspace.exists() or workspace.is_symlink():
        raise ValueError("Restore requires a new workspace path; existing data is never overwritten.")
    learning = learning_directory(workspace / "persona-data")
    if learning.exists() or learning.is_symlink():
        raise ValueError("The destination already has learning data; choose another workspace path.")
    workspace.parent.mkdir(parents=True, exist_ok=True)
    created = False
    learning_created = False
    with tempfile.TemporaryDirectory(prefix=".persona-restore-", dir=workspace.parent) as tmp:
        staged = Path(tmp)
        try:
            manifest = _extract_verified(archive.expanduser().resolve(), staged)
        except tarfile.TarError as exc:
            raise ValueError("Cannot read this backup archive.") from exc
        if is_demo_data(staged / "persona-data"):
            raise ValueError("Demo archives cannot be restored as real workspaces.")
        store = PersonaStore(staged / "persona-data").load()
        if (store.config.persona_id != manifest["persona_id"]
                or store.config.revision != manifest["persona_revision"]
                or len(store.records) != manifest["record_count"]
                or len(store.sources) != manifest["source_count"]):
            raise ValueError("Backup record identity or counts do not match its manifest.")
        _disable_integrations(staged)
        (staged / "persona-state").mkdir(exist_ok=True, mode=0o700)
        try:
            workspace.mkdir(mode=0o700)  # Exclusive reservation; never replaces a raced-in path.
            created = True
            for name in ("persona-data", "persona-state"):
                shutil.move(str(staged / name), workspace / name)
            if (staged / "conversation-learning").exists():
                learning.parent.mkdir(parents=True, exist_ok=True)
                learning.mkdir(mode=0o700)
                learning_created = True
                shutil.copytree(staged / "conversation-learning", learning, dirs_exist_ok=True)
            # Regenerate path-sensitive indexes using the final location.
            PersonaCompiler(workspace / "persona-data", workspace / "persona-state").build()
        except BaseException:
            if learning_created:
                shutil.rmtree(learning)
            if created:
                shutil.rmtree(workspace)
            raise
    return {"ok": True, "workspace": str(workspace.resolve()), "learning_directory": str(learning),
            "persona_revision": manifest["persona_revision"], "records": manifest["record_count"],
            "sources": manifest["source_count"], "automatic_features_enabled": False,
            "next_step": "Open the workspace, then review and reconnect application integrations."}


def migrate_workspace(source: Path, destination: Path, *, learning_dir: Path | None = None) -> dict:
    destination = destination.expanduser().absolute()
    if destination.exists() or destination.is_symlink():
        raise ValueError("Migration requires a new destination; existing data is never overwritten.")
    with tempfile.TemporaryDirectory(prefix="persona-migrate-") as tmp:
        archive = Path(tmp) / "workspace.tar.gz"
        backup_workspace(source, archive, learning_dir=learning_dir)
        result = restore_workspace(archive, destination)
    return {**result, "source_preserved": True}
