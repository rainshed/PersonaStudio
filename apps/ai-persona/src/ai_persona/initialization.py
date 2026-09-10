from __future__ import annotations

import re
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .compiler import PersonaCompiler
from .frontmatter import dump_markdown_record
from .models import Tag


class InitializationError(ValueError):
    """Raised when a new persona cannot be initialized safely."""


@dataclass(frozen=True)
class InitializationResult:
    persona_id: str
    persona_revision: int
    created_at: datetime
    data_root: Path
    state_root: Path
    snapshot_path: Path
    state_database: Path


REQUIRED_DIRECTORIES = (
    "config",
    "schemas",
    "records/knowledge-nodes",
    "records/courses",
    "records/materials",
    "records/relations",
    "records/evidence",
    "records/tags",
    "records/preference-contexts",
    "records/preferences",
    "records/preference-examples",
    "sources",
    "proposals/pending",
    "proposals/history",
    "proposals/change-sets",
    "revisions",
)

INITIAL_DOMAIN_TAGS = (
    {
        "id": "tag_ai",
        "slug": "ai",
        "label": "AI",
        "aliases": ["artificial intelligence", "人工智能"],
    },
    {
        "id": "tag_physics",
        "slug": "physics",
        "label": "Physics",
        "aliases": ["物理", "物理学"],
    },
)


def _validate_persona_id(value: str) -> str:
    normalized = value.strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{1,63}", normalized):
        raise InitializationError(
            "persona ID 必须为 2–64 个小写字母、数字、连字符或下划线，且以字母或数字开头"
        )
    return normalized


def _validate_empty_target(path: Path, label: str) -> bool:
    if path == Path(path.anchor):
        raise InitializationError(f"{label} 不能指向文件系统根目录")
    if not path.exists():
        return False
    if not path.is_dir():
        raise InitializationError(f"{label} 已存在且不是目录：{path}")
    if any(path.iterdir()):
        raise InitializationError(f"{label} 已存在且非空，不会覆盖：{path}")
    return True


def _paths_overlap(first: Path, second: Path) -> bool:
    return first == second or first in second.parents or second in first.parents


def initialize_persona(
    data_root: Path,
    state_root: Path,
    *,
    persona_id: str,
) -> InitializationResult:
    """Create a complete, empty persona without overwriting existing content."""

    normalized_id = _validate_persona_id(persona_id)
    resolved_data_root = data_root.resolve()
    resolved_state_root = state_root.resolve()
    if _paths_overlap(resolved_data_root, resolved_state_root):
        raise InitializationError("data 和 state 目录必须彼此独立，不能相同或互相包含")

    data_existed = _validate_empty_target(resolved_data_root, "data 目录")
    state_existed = _validate_empty_target(resolved_state_root, "state 目录")
    resolved_data_root.parent.mkdir(parents=True, exist_ok=True)
    resolved_state_root.parent.mkdir(parents=True, exist_ok=True)

    temporary_data_root = Path(
        tempfile.mkdtemp(prefix=".ai-persona-data-", dir=resolved_data_root.parent)
    )
    temporary_state_root = Path(
        tempfile.mkdtemp(prefix=".ai-persona-state-", dir=resolved_state_root.parent)
    )
    data_published = False
    state_published = False
    data_target_removed = False
    state_target_removed = False
    created_at = datetime.now(timezone.utc).replace(microsecond=0)
    try:
        for relative_path in REQUIRED_DIRECTORIES:
            (temporary_data_root / relative_path).mkdir(parents=True, exist_ok=True)
        timestamp = created_at.isoformat().replace("+00:00", "Z")
        (temporary_data_root / "config" / "persona.toml").write_text(
            "\n".join(
                [
                    "[persona]",
                    f'id = "{normalized_id}"',
                    "revision = 1",
                    f'created_at = "{timestamp}"',
                    "include_human_notes_in_snapshot = true",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        (temporary_data_root / "revisions" / "changes.jsonl").write_text(
            "", encoding="utf-8"
        )
        for item in INITIAL_DOMAIN_TAGS:
            tag = Tag.model_validate(
                {
                    "schema": "ai-persona.tag/v1",
                    "entity_type": "tag",
                    "namespace": "domain",
                    "status": "active",
                    "revision": 1,
                    "created_at": timestamp,
                    "updated_at": timestamp,
                    **item,
                }
            )
            tag_path = temporary_data_root / "records" / "tags" / f"{tag.id}.md"
            tag_path.write_text(
                dump_markdown_record(
                    tag.model_dump(mode="json", by_alias=True, exclude_none=False),
                    "",
                ),
                encoding="utf-8",
            )

        PersonaCompiler(temporary_data_root, temporary_state_root).build()

        if data_existed:
            resolved_data_root.rmdir()
            data_target_removed = True
        temporary_data_root.replace(resolved_data_root)
        data_published = True
        if state_existed:
            resolved_state_root.rmdir()
            state_target_removed = True
        temporary_state_root.replace(resolved_state_root)
        state_published = True
    except Exception:
        if state_published and resolved_state_root.exists():
            shutil.rmtree(resolved_state_root)
            if state_existed:
                resolved_state_root.mkdir()
        elif state_target_removed:
            resolved_state_root.mkdir()
        if data_published and resolved_data_root.exists():
            shutil.rmtree(resolved_data_root)
            if data_existed:
                resolved_data_root.mkdir()
        elif data_target_removed:
            resolved_data_root.mkdir()
        raise
    finally:
        if temporary_data_root.exists():
            shutil.rmtree(temporary_data_root)
        if temporary_state_root.exists():
            shutil.rmtree(temporary_state_root)

    return InitializationResult(
        persona_id=normalized_id,
        persona_revision=1,
        created_at=created_at,
        data_root=resolved_data_root,
        state_root=resolved_state_root,
        snapshot_path=resolved_data_root / "generated" / "persona.snapshot.json",
        state_database=resolved_state_root / "persona.sqlite3",
    )
