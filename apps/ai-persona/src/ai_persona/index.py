from __future__ import annotations

import json
import os
import re
import sqlite3
import tempfile
from pathlib import Path
from typing import Any

from .models import (
    Course,
    Evidence,
    KnowledgeNode,
    Material,
    Preference,
    PreferenceContext,
    PreferenceExample,
    Relation,
)
from .store import PersonaStore


def build_index(store: PersonaStore, state_root: Path) -> Path:
    state_root.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="persona-",
        suffix=".sqlite3",
        dir=state_root,
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    final_path = state_root / "persona.sqlite3"
    try:
        connection = sqlite3.connect(temporary_path)
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(
            """
            CREATE TABLE meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE entities (
                id TEXT PRIMARY KEY,
                entity_type TEXT NOT NULL,
                title TEXT NOT NULL,
                semantic_role TEXT,
                knowledge_level TEXT NOT NULL,
                interest_level TEXT,
                preference_level TEXT,
                abstract TEXT NOT NULL,
                summary TEXT NOT NULL,
                description TEXT NOT NULL,
                syllabus TEXT NOT NULL,
                body TEXT NOT NULL
            );
            CREATE VIRTUAL TABLE entity_fts USING fts5(
                id UNINDEXED,
                title,
                aliases,
                abstract,
                summary,
                description,
                syllabus,
                body,
                tokenize='unicode61 remove_diacritics 2'
            );
            CREATE TABLE relations (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                relation_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                knowledge_role TEXT,
                salience TEXT,
                statement TEXT
            );
            CREATE INDEX relations_source_idx ON relations(source_id, relation_type);
            CREATE INDEX relations_target_idx ON relations(target_id, relation_type);
            CREATE TABLE relation_closure (
                ancestor_id TEXT NOT NULL,
                descendant_id TEXT NOT NULL,
                distance INTEGER NOT NULL,
                PRIMARY KEY(ancestor_id, descendant_id)
            );
            CREATE INDEX relation_closure_desc_idx
                ON relation_closure(descendant_id, distance);
            CREATE TABLE materials (
                id TEXT PRIMARY KEY,
                material_type TEXT NOT NULL,
                user_relationships_json TEXT NOT NULL,
                bibliography_json TEXT NOT NULL,
                preference_reasons_json TEXT NOT NULL,
                source_ref TEXT NOT NULL,
                FOREIGN KEY(id) REFERENCES entities(id)
            );
            CREATE TABLE preference_contexts (
                id TEXT PRIMARY KEY,
                context_key TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                activation_json TEXT NOT NULL,
                revision INTEGER NOT NULL
            );
            CREATE TABLE preferences (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                context_refs_json TEXT NOT NULL,
                behavior TEXT NOT NULL,
                instruction TEXT NOT NULL,
                condition_text TEXT NOT NULL,
                rationale TEXT NOT NULL,
                revision INTEGER NOT NULL
            );
            CREATE TABLE preference_examples (
                id TEXT PRIMARY KEY,
                context_refs_json TEXT NOT NULL,
                example_type TEXT NOT NULL,
                title TEXT NOT NULL,
                condition_text TEXT NOT NULL,
                reasons_json TEXT NOT NULL,
                source_ref TEXT NOT NULL,
                canonical_file TEXT NOT NULL,
                original_filename TEXT NOT NULL,
                content_hash TEXT NOT NULL,
                revision INTEGER NOT NULL
            );
            CREATE TABLE evidence_locators (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                locator_json TEXT NOT NULL,
                confidence REAL
            );
            """
        )
        assert store.config is not None
        connection.executemany(
            "INSERT INTO meta(key, value) VALUES (?, ?)",
            [
                ("schema_version", "ai-persona.index/v6"),
                ("persona_id", store.config.persona_id),
                ("persona_revision", str(store.config.revision)),
            ],
        )

        for loaded in store.active_knowledge():
            record = loaded.record
            assert isinstance(record, (KnowledgeNode, Course, Material))
            semantic_role = record.semantic_role if isinstance(record, KnowledgeNode) else None
            interest_level = None if isinstance(record, Material) else record.interest_level
            preference_level = (
                record.preference_level if isinstance(record, Material) else None
            )
            aliases = "\n".join(record.aliases)
            searchable_body = loaded.body
            abstract = record.abstract if isinstance(record, Material) else ""
            summary = getattr(record, "summary", "")
            description = record.description if isinstance(record, Course) else ""
            syllabus = record.syllabus if isinstance(record, Course) else ""
            if isinstance(record, Material):
                manifest = store.sources[record.source_ref]
                source_root = store.data_root / "sources" / manifest.id
                extracted = next(
                    (item for item in manifest.files if item.role == "extracted_text"),
                    None,
                )
                original = next(item for item in manifest.files if item.role == "original")
                searchable_file = extracted or original
                if searchable_file.media_type.startswith("text/"):
                    source_text = (source_root / searchable_file.path).read_text(
                        encoding="utf-8", errors="replace"
                    )
                    searchable_body = f"{searchable_body}\n\n{source_text}".strip()
            connection.execute(
                """
                INSERT INTO entities(
                    id, entity_type, title, semantic_role, knowledge_level,
                    interest_level, preference_level, abstract, summary,
                    description, syllabus, body
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.entity_type,
                    record.title,
                    semantic_role,
                    record.knowledge_level,
                    interest_level,
                    preference_level,
                    abstract,
                    summary,
                    description,
                    syllabus,
                    loaded.body,
                ),
            )
            connection.execute(
                """
                INSERT INTO entity_fts(
                    id, title, aliases, abstract, summary, description, syllabus, body
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.title,
                    aliases,
                    abstract,
                    summary,
                    description,
                    syllabus,
                    searchable_body,
                ),
            )
            if isinstance(record, Material):
                connection.execute(
                    """
                    INSERT INTO materials(
                        id, material_type, user_relationships_json, bibliography_json,
                        preference_reasons_json, source_ref
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record.id,
                        record.material_type,
                        json.dumps(record.user_relationships, ensure_ascii=False),
                        json.dumps(
                            record.bibliography.model_dump(mode="json"),
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                        json.dumps(
                            [item.model_dump(mode="json") for item in record.preference_reasons],
                            ensure_ascii=False,
                            sort_keys=True,
                        ),
                        record.source_ref,
                    ),
                )

        connection.executemany(
            """
            INSERT INTO relations(
                id, source_id, relation_type, target_id,
                knowledge_role, salience, statement
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            [
                (
                    relation.id,
                    relation.source_id,
                    relation.relation_type,
                    relation.target_id,
                    relation.knowledge_role,
                    relation.salience,
                    relation.statement,
                )
                for relation in store.of_type(Relation, active_only=True)
            ],
        )
        connection.executemany(
            """
            INSERT INTO relation_closure(ancestor_id, descendant_id, distance)
            VALUES (?, ?, ?)
            """,
            store.relation_closure(),
        )

        for context in store.of_type(PreferenceContext, active_only=True):
            connection.execute(
                """
                INSERT INTO preference_contexts(
                    id, context_key, name, description, activation_json, revision
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    context.id,
                    context.key,
                    context.name,
                    context.description,
                    json.dumps(
                        context.activation.model_dump(mode="json"),
                        ensure_ascii=False,
                        sort_keys=True,
                    ),
                    context.revision,
                ),
            )
        for preference in store.of_type(Preference, active_only=True):
            connection.execute(
                """
                INSERT INTO preferences(
                    id, scope, context_refs_json, behavior, instruction,
                    condition_text, rationale, revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    preference.id,
                    preference.scope,
                    json.dumps(preference.context_refs, ensure_ascii=False),
                    preference.behavior,
                    preference.instruction,
                    preference.condition,
                    preference.rationale,
                    preference.revision,
                ),
            )
        for loaded in store.loaded_of_type(PreferenceExample, active_only=True):
            example = loaded.record
            assert isinstance(example, PreferenceExample)
            manifest = store.sources[example.source_ref]
            connection.execute(
                """
                INSERT INTO preference_examples(
                    id, context_refs_json, example_type, title, condition_text,
                    reasons_json, source_ref, canonical_file, original_filename,
                    content_hash, revision
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    example.id,
                    json.dumps(example.context_refs, ensure_ascii=False),
                    example.example_type,
                    example.title,
                    example.condition,
                    json.dumps(example.reasons, ensure_ascii=False),
                    example.source_ref,
                    manifest.canonical_file,
                    manifest.origin.identifier or manifest.canonical_file,
                    example.content_hash,
                    example.revision,
                ),
            )
        for evidence in store.of_type(Evidence, active_only=True):
            connection.execute(
                """
                INSERT INTO evidence_locators(
                    id, source_id, source_hash, locator_json, confidence
                ) VALUES (?, ?, ?, ?, ?)
                """,
                (
                    evidence.id,
                    evidence.source_id,
                    evidence.source_hash,
                    json.dumps(evidence.locator, ensure_ascii=False, sort_keys=True),
                    evidence.confidence,
                ),
            )

        integrity = connection.execute("PRAGMA integrity_check").fetchone()
        if integrity is None or integrity[0] != "ok":
            raise RuntimeError(f"SQLite integrity check failed: {integrity}")
        connection.commit()
        connection.close()
        os.replace(temporary_path, final_path)
        return final_path
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def _fts_query(query: str) -> str:
    terms = re.findall(r"[\wÀ-ž\u3400-\u9fff-]+", query, flags=re.UNICODE)
    if not terms:
        raise ValueError("search query contains no searchable terms")
    return " OR ".join(f'"{term.replace(chr(34), chr(34) * 2)}"' for term in terms[:20])


def rank_knowledge_ids(
    state_root: Path, query: str, *, allowed_ids: set[str], expected_revision: int
) -> list[str]:
    """Rank within the caller's eligible set; pagination happens after all filters."""
    database = state_root / "persona.sqlite3"
    connection = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    try:
        row = connection.execute(
            "SELECT value FROM meta WHERE key='persona_revision'"
        ).fetchone()
        if row is None or int(row[0]) != expected_revision:
            raise ValueError("index_revision_changed")
        if not allowed_ids:
            return []
        # A temporary table avoids SQL parameter limits for large tag collections.
        connection.execute("CREATE TEMP TABLE eligible_ids (id TEXT PRIMARY KEY)")
        connection.executemany(
            "INSERT INTO eligible_ids VALUES (?)", ((item,) for item in sorted(allowed_ids))
        )
        return [
            row[0]
            for row in connection.execute(
                """
                SELECT entity_fts.id, bm25(entity_fts) AS rank
                FROM entity_fts JOIN eligible_ids ON eligible_ids.id=entity_fts.id
                WHERE entity_fts MATCH ? ORDER BY rank, entity_fts.id
                """,
                (_fts_query(query),),
            )
        ]
    finally:
        connection.close()


def search_index(state_root: Path, query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    database = state_root / "persona.sqlite3"
    if not database.is_file():
        raise FileNotFoundError(f"index does not exist: {database}; run build first")
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        rows = connection.execute(
            """
            SELECT e.*, bm25(entity_fts) AS rank
            FROM entity_fts
            JOIN entities e ON e.id=entity_fts.id
            WHERE entity_fts MATCH ?
            ORDER BY rank, e.id
            LIMIT ?
            """,
            (_fts_query(query), max(1, min(limit, 100))),
        ).fetchall()
        results: list[dict[str, Any]] = []
        for row in rows:
            ancestors = [
                {
                    "id": item["ancestor_id"],
                    "distance": item["distance"],
                }
                for item in connection.execute(
                    """
                    SELECT ancestor_id, distance FROM relation_closure
                    WHERE descendant_id=? ORDER BY distance, ancestor_id
                    """,
                    (row["id"],),
                )
            ]
            results.append(
                {
                    "id": row["id"],
                    "entity_type": row["entity_type"],
                    "title": row["title"],
                    "semantic_role": row["semantic_role"],
                    "knowledge_level": row["knowledge_level"],
                    "interest_level": row["interest_level"],
                    "preference_level": row["preference_level"],
                    "abstract": row["abstract"],
                    "summary": row["summary"],
                    "description": row["description"],
                    "syllabus": row["syllabus"],
                    "ancestors": ancestors,
                }
            )
        return results
    finally:
        connection.close()


def prepare_context(
    state_root: Path,
    *,
    context_key: str,
    question: str,
    knowledge_limit: int = 8,
    example_limit: int = 3,
) -> dict[str, Any]:
    knowledge = search_index(state_root, question, limit=knowledge_limit)
    database = state_root / "persona.sqlite3"
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        revision_row = connection.execute(
            "SELECT value FROM meta WHERE key='persona_revision'"
        ).fetchone()
        matched_context = connection.execute(
            "SELECT * FROM preference_contexts WHERE context_key=?",
            (context_key,),
        ).fetchone()
        preference_context: dict[str, Any] | None = None
        selected_preferences: list[dict[str, Any]] = []
        for row in connection.execute(
            """
            SELECT * FROM preferences
            ORDER BY
              CASE behavior
                WHEN 'required' THEN 0
                WHEN 'preferred' THEN 1
                ELSE 2
              END,
              id
            """
        ):
            context_refs = json.loads(row["context_refs_json"])
            if row["scope"] == "global" or (
                matched_context is not None and matched_context["id"] in context_refs
            ):
                selected_preferences.append(
                    {
                        "id": row["id"],
                        "scope": row["scope"],
                        "context_refs": context_refs,
                        "behavior": row["behavior"],
                        "instruction": row["instruction"],
                        "condition": row["condition_text"],
                        "rationale": row["rationale"],
                        "revision": row["revision"],
                    }
                )
        examples: list[dict[str, Any]] = []
        max_examples = max(0, min(example_limit, 10))
        if matched_context is not None and max_examples:
            for row in connection.execute(
                "SELECT * FROM preference_examples ORDER BY example_type DESC, id"
            ):
                context_refs = json.loads(row["context_refs_json"])
                if matched_context["id"] not in context_refs:
                    continue
                examples.append(
                    {
                        "id": row["id"],
                        "context_refs": context_refs,
                        "example_type": row["example_type"],
                        "title": row["title"],
                        "condition": row["condition_text"],
                        "reasons": json.loads(row["reasons_json"]),
                        "source_ref": row["source_ref"],
                        "canonical_file": row["canonical_file"],
                        "filename": row["original_filename"],
                        "content_hash": row["content_hash"],
                        "revision": row["revision"],
                    }
                )
                if len(examples) >= max_examples:
                    break
        if selected_preferences or examples:
            matched_contexts = []
            if matched_context is not None:
                matched_contexts.append(
                    {
                        "id": matched_context["id"],
                        "key": matched_context["context_key"],
                        "name": matched_context["name"],
                        "description": matched_context["description"],
                        "activation": json.loads(matched_context["activation_json"]),
                        "revision": matched_context["revision"],
                    }
                )
            preference_context = {
                "matched_contexts": matched_contexts,
                "preferences": selected_preferences,
                "selected_examples": examples,
            }
        return {
            "persona_revision": int(revision_row["value"]) if revision_row else None,
            "context_key": context_key,
            "question": question,
            "relevant_knowledge": knowledge,
            "preference_context": preference_context,
        }
    finally:
        connection.close()
