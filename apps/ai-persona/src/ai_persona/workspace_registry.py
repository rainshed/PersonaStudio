"""Local workspace names and recents; never modifies persona records."""

import json
import sqlite3
from contextlib import closing
from pathlib import Path

from .workspace import user_config_path


def display_name(data_root):
    try:
        return json.loads((data_root.parent / "persona-state/workspace-name.json").read_text())[
            "name"
        ]
    except (OSError, ValueError, KeyError):
        return data_root.parent.name if data_root.name == "persona-data" else data_root.name


def forget(path):
    database = user_config_path().parent / "workspaces.sqlite3"
    if database.exists():
        with closing(sqlite3.connect(database)) as db, db:
            db.execute("DELETE FROM recent WHERE path=?", (path,))


def remember(root, name=None):
    root = Path(root).resolve()
    if name:
        name = str(name).strip()[:80]
        target = root / "persona-state/workspace-name.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(".tmp")
        temporary.write_text(json.dumps({"name": name}, ensure_ascii=False))
        temporary.replace(target)
    directory = user_config_path().parent
    directory.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(directory / "workspaces.sqlite3")) as db, db:
        db.execute(
            "CREATE TABLE IF NOT EXISTS recent (path TEXT PRIMARY KEY, name TEXT, opened REAL)"
        )
        db.execute(
            "INSERT OR REPLACE INTO recent VALUES (?, ?, julianday('now'))",
            (str(root), display_name(root / "persona-data")),
        )


def recents():
    path = user_config_path().parent / "workspaces.sqlite3"
    if not path.exists():
        return []
    with closing(sqlite3.connect(path)) as db:
        rows = db.execute("SELECT path,name FROM recent ORDER BY opened DESC LIMIT 20").fetchall()
    return [
        {"path": p, "name": n, "exists": (Path(p) / "persona-data/config/persona.toml").is_file()}
        for p, n in rows
    ]
