#!/usr/bin/env python3
"""Private Radar backups: verified files, no links, restore only to a new directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import tarfile
import tempfile

SCHEMA = "paper-radar.backup/v1"
MAX_BYTES = 20 * 1024 ** 3


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def create(source, output):
    files = {}
    for path in sorted(source.rglob("*")):
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError("Backups cannot contain links or special files")
        if path.is_file():
            files[path.relative_to(source).as_posix()] = {"sha256": digest(path), "size": path.stat().st_size}
    manifest = source / "manifest.json"
    manifest.write_text(json.dumps({"schema": SCHEMA, "files": files}, indent=2))
    with tarfile.open(output, "x:gz") as archive:
        for path in sorted(source.rglob("*")):
            archive.add(path, arcname=path.relative_to(source).as_posix(), recursive=False)
    output.chmod(0o600)


def restore(archive_path, destination):
    if destination.exists() or destination.is_symlink():
        raise ValueError("Restore requires a new directory; existing data is never replaced")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".radar-restore-", dir=destination.parent))
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            members = archive.getmembers()
            if len(members) > 200000 or sum(item.size for item in members) > MAX_BYTES:
                raise ValueError("Backup exceeds the restore size limit")
            names = set()
            for item in members:
                name = PurePosixPath(item.name)
                if (not item.name or name.is_absolute() or ".." in name.parts or "\\" in item.name
                        or str(name) != item.name or item.name in names
                        or not (item.isfile() or item.isdir())
                        or (item.name != "manifest.json" and name.parts[0] != "data")):
                    raise ValueError("Backup contains an unsafe or duplicate entry")
                names.add(item.name)
            archive.extractall(temporary, members=members, filter="data")
        manifest = json.loads((temporary / "manifest.json").read_text())
        if manifest.get("schema") != SCHEMA or not isinstance(manifest.get("files"), dict):
            raise ValueError("Unsupported backup format")
        actual = {p.relative_to(temporary).as_posix() for p in temporary.rglob("*") if p.is_file() and p.relative_to(temporary).as_posix() != "manifest.json"}
        if actual != set(manifest["files"]):
            raise ValueError("Backup file list does not match its manifest")
        for name, expected in manifest["files"].items():
            path = temporary / name
            if path.stat().st_size != expected["size"] or digest(path) != expected["sha256"]:
                raise ValueError("Backup checksum verification failed")
        database = temporary / "data/radar.sqlite"
        if not database.is_file():
            raise ValueError("Backup is missing its database")
        with sqlite3.connect(database) as connection:
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Backup database failed its integrity check")
            if connection.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("Backup database contains broken references")
            # Restoring never silently restarts scheduled model work.
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "daily_schedules" in tables:
                for key, value in connection.execute("SELECT subscription_id,data FROM daily_schedules").fetchall():
                    schedule = json.loads(value)
                    schedule.update(enabled=False, next_check_at=None, revision=schedule["revision"] + 1)
                    connection.execute("UPDATE daily_schedules SET enabled=0,next_check_at=NULL,revision=?,data=? WHERE subscription_id=?", (schedule["revision"], json.dumps(schedule), key))
        prompts = temporary / "data/prompts/prompts.sqlite3"
        if prompts.is_file():
            with sqlite3.connect(prompts) as connection:
                if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise ValueError("Prompt database failed its integrity check")
        # Never carry a pending connection switch into a recovered workspace.
        persona = temporary / "data/persona.json"
        if persona.is_file():
            configuration = json.loads(persona.read_text())
            configuration["pending_connection"] = None
            persona.write_text(json.dumps(configuration, ensure_ascii=False, indent=2))
        for path in temporary.rglob("*"):
            path.chmod(0o700 if path.is_dir() else 0o600)
        # Atomic creation refuses an existing nonempty target. Recheck immediately before rename.
        if destination.exists() or destination.is_symlink():
            raise ValueError("Restore destination was created by another process")
        os.rename(temporary / "data", destination)
        return {"restored": True, "directory": str(destination), "automatic_checks_paused": True}
    finally:
        shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["create", "restore"])
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    if args.action == "create":
        create(args.source, args.destination)
    else:
        print(json.dumps(restore(args.source, args.destination), ensure_ascii=False))


if __name__ == "__main__":
    main()
