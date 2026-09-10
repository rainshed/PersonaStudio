"""Registration of the six public query tools."""

from __future__ import annotations

import base64
from typing import Annotated, Literal

from mcp.types import CallToolResult, ImageContent, TextContent, ToolAnnotations
from pydantic import Field, ValidationError

from .agent import AgentServiceError, ErrorDetail, TagScope
from .models import MaterialKnowledgeRole, RelationSalience
from .query_contracts import FileRef, QueryResult, SourceSelector, encoded
from .query_service import KnowledgeQueryService

ReadResult = Annotated[CallToolResult, QueryResult]
Scope = TagScope | None
Revision = Annotated[int, Field(ge=1)] | None
Budget = Annotated[int, Field(ge=1000, le=200000)]
RecordIds = Annotated[list[str], Field(min_length=1, max_length=10)]
RelationTypes = list[Literal[
    "broader_than", "part_of", "requires", "applied_in", "related_to", "covers",
]] | None
Direction = Literal["incoming", "outgoing", "both"]
READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False,
                            idempotentHint=True, openWorldHint=False)


def _call(tool, operation) -> CallToolResult:
    try:
        value = operation()
    except Exception as exc:
        if isinstance(exc, AgentServiceError):
            code = {"invalid_request": "invalid_arguments", "stale_revision": "version_changed",
                    "out_of_scope": "not_found_or_not_visible"}.get(exc.code, exc.code)
            error = ErrorDetail(code=code, message=exc.message,
                                retryable=exc.retryable, details=exc.details)
        elif isinstance(exc, ValidationError):
            error = ErrorDetail(code="invalid_arguments", message="Invalid query arguments.")
        else:
            error = ErrorDetail(code="query_unavailable",
                                message="This query could not be completed.", retryable=True)
        value = QueryResult(tool=tool, ok=False, error=error)
    payload = value.model_dump(mode="json")
    content = [TextContent(type="text", text=encoded(payload))]
    content.extend(ImageContent(type="image", mime_type="image/png",
                                data=base64.b64encode(image).decode()) for image in value._images)
    return CallToolResult(content=content, structured_content=payload, is_error=not value.ok)


def register_query_tools(server, data_root, state_root, *, service=None):
    service = service or KnowledgeQueryService(data_root, state_root)

    @server.tool(
        name="get_knowledge_map", annotations=READ_ONLY, structured_output=True,
        description="Read the reviewed knowledge map, including domain IDs, personal states and "
        "typed relationships. Omit focus_ids for an overview; supply known IDs to expand their "
        "neighborhood. Coverage and cursors identify unread content. For a specific question "
        "you may call search_knowledge directly. Preferences follow the existing activation flow.",
    )
    def get_knowledge_map(
        focus_ids: RecordIds | None = None, max_hops: Annotated[int, Field(ge=1, le=2)] = 1,
        relation_types: RelationTypes = None, direction: Direction = "both",
        knowledge_role: MaterialKnowledgeRole | None = None, salience: RelationSalience | None = None,
        scope: Scope = None, expected_persona_revision: Revision = None,
        max_chars: Budget = 32000, cursor: str | None = None,
    ) -> ReadResult:
        return _call("get_knowledge_map", lambda: service.get_knowledge_map(
            focus_ids=focus_ids, max_hops=max_hops, relation_types=relation_types,
            direction=direction, knowledge_role=knowledge_role, salience=salience, scope=scope,
            expected_persona_revision=expected_persona_revision, max_chars=max_chars, cursor=cursor,
        ))

    @server.tool(
        name="search_knowledge", annotations=READ_ONLY, structured_output=True,
        description="Find reviewed knowledge, courses and materials for a natural-language question. "
        "Combines text, local multilingual semantics and graph expansion, returning personal "
        "states, relationship paths and source excerpts. Optional focus_ids prioritize a direction; "
        "focus_mode=only restricts to that neighborhood. Scope is always a strict boundary. "
        "An empty query requires structured filters and cannot use focus_ids.",
    )
    def search_knowledge(
        query: Annotated[str, Field(max_length=12000)] = "", focus_ids: RecordIds | None = None,
        focus_mode: Literal["prefer", "only"] = "prefer",
        max_hops: Annotated[int, Field(ge=1, le=2)] = 1,
        relation_types: RelationTypes = None, direction: Direction = "both",
        entity_types: list[Literal["knowledge_node", "course", "material"]] | None = None,
        knowledge_levels: list[Literal["proficient", "familiar", "aware", "unspecified"]] | None = None,
        interest_levels: list[Literal["high", "medium", "low", "unspecified"]] | None = None,
        material_types: list[Literal["article", "note", "paper", "book", "course_material",
                                    "conversation", "resume", "other"]] | None = None,
        user_relationships: list[Literal["authored", "studied", "read", "skimmed"]] | None = None,
        scope: Scope = None, expected_persona_revision: Revision = None,
        limit: Annotated[int, Field(ge=1, le=50)] = 10,
        max_chars: Budget = 24000, cursor: str | None = None,
    ) -> ReadResult:
        return _call("search_knowledge", lambda: service.search_knowledge(
            query=query, focus_ids=focus_ids, focus_mode=focus_mode, max_hops=max_hops,
            relation_types=relation_types, direction=direction, entity_types=entity_types,
            knowledge_levels=knowledge_levels, interest_levels=interest_levels,
            material_types=material_types, user_relationships=user_relationships,
            scope=scope, expected_persona_revision=expected_persona_revision,
            limit=limit, max_chars=max_chars, cursor=cursor,
        ))

    @server.tool(
        name="get_persona_records", annotations=READ_ONLY, structured_output=True,
        description="Read complete reviewed knowledge/course/material/relation records by known IDs in a "
        "batch, with personal notes, revisions and evidence references. Optional fields select "
        "a projection; include_evidence adds evidence metadata. Continue a partial read with "
        "its cursor. Use get_knowledge_map to explore relationships, read_source for original evidence.",
    )
    def get_persona_records(
        record_ids: RecordIds, fields: list[str] | None = None, include_evidence: bool = False,
        scope: Scope = None, expected_persona_revision: Revision = None,
        max_chars: Budget = 24000, cursor: str | None = None,
    ) -> ReadResult:
        return _call("get_persona_records", lambda: service.get_persona_records(
            record_ids=record_ids, fields=fields, include_evidence=include_evidence, scope=scope,
            expected_persona_revision=expected_persona_revision, max_chars=max_chars, cursor=cursor,
        ))

    @server.tool(
        name="list_source_files", annotations=READ_ONLY, structured_output=True,
        description="Browse the manifest-declared files of a known material or injected preference "
        "sample source. Returns stable file IDs, relative directories, original/extracted/attachment "
        "roles, available views and per-file parse status. No host filesystem access is needed.",
    )
    def list_source_files(
        source_id: str, directory: str = "", recursive: bool = False,
        file_types: list[str] | None = None, limit: Annotated[int, Field(ge=1, le=200)] = 50,
        scope: Scope = None, expected_persona_revision: Revision = None,
        max_chars: Budget = 16000, cursor: str | None = None,
    ) -> ReadResult:
        return _call("list_source_files", lambda: service.list_source_files(
            source_id=source_id, directory=directory, recursive=recursive,
            file_types=file_types, limit=limit, scope=scope,
            expected_persona_revision=expected_persona_revision, max_chars=max_chars, cursor=cursor,
        ))

    @server.tool(
        name="search_source_content", annotations=READ_ONLY, structured_output=True,
        description="Locate passages inside explicitly selected sources OR files. Returns original "
        "text, verifiable locators, source hashes and passage_ref for read_source. Inspect "
        "index_coverage for unsupported or failed files. To discover unknown materials use "
        "search_knowledge first.",
    )
    def search_source_content(
        query: Annotated[str, Field(min_length=1, max_length=12000)],
        source_ids: Annotated[list[str], Field(min_length=1, max_length=100)] | None = None,
        files: Annotated[list[FileRef], Field(min_length=1, max_length=100)] | None = None,
        limit: Annotated[int, Field(ge=1, le=50)] = 10,
        context_chars: Annotated[int, Field(ge=100, le=4000)] = 600,
        scope: Scope = None, expected_persona_revision: Revision = None,
        max_chars: Budget = 24000, cursor: str | None = None,
    ) -> ReadResult:
        return _call("search_source_content", lambda: service.search_source_content(
            query=query, source_ids=source_ids, files=files, limit=limit, context_chars=context_chars,
            scope=scope, expected_persona_revision=expected_persona_revision,
            max_chars=max_chars, cursor=cursor,
        ))

    @server.tool(
        name="read_source", annotations=READ_ONLY, structured_output=True,
        description="Read a declared source_id+file_id, an evidence_id, OR a passage_ref. "
        "Returns outline, original text, actual images or supported structured data. Auto reads "
        "document outlines, evidence/passage text and source images. Use image with PDF page "
        "selectors for visual references. Lines/pages are one-based; next_selector continues "
        "a truncated read. Never supply a local path as file_id.",
    )
    def read_source(
        source_id: str | None = None, file_id: str | None = None,
        evidence_id: str | None = None, passage_ref: str | None = None,
        view: Literal["auto", "outline", "text", "image", "structured"] = "auto",
        selector: SourceSelector | None = None,
        max_images: Annotated[int, Field(ge=1, le=4)] = 1,
        scope: Scope = None, expected_persona_revision: Revision = None, max_chars: Budget = 16000,
    ) -> ReadResult:
        return _call("read_source", lambda: service.read_source(
            source_id=source_id, file_id=file_id, evidence_id=evidence_id, passage_ref=passage_ref,
            view=view, selector=selector, max_images=max_images, scope=scope,
            expected_persona_revision=expected_persona_revision, max_chars=max_chars,
        ))

    @server.tool(name="search_preferences", annotations=READ_ONLY, structured_output=True,
                 description="Find reviewed preferences, contexts and examples for maintenance, "
                 "including inactive contexts. This does not activate preferences or change data.")
    def search_preferences(
        query: Annotated[str, Field(max_length=12000)] = "",
        context_ids: list[str] | None = None,
        statuses: list[str] | None = None,
        limit: Annotated[int, Field(ge=1, le=50)] = 16,
        expected_persona_revision: Revision = None, max_chars: Budget = 24000,
        cursor: str | None = None,
    ) -> ReadResult:
        return _call("search_preferences", lambda: service.search_preferences(
            query=query, context_ids=context_ids, statuses=statuses, limit=limit,
            expected_persona_revision=expected_persona_revision, max_chars=max_chars, cursor=cursor,
        ))

    @server.tool(name="get_preference_records", annotations=READ_ONLY, structured_output=True,
                 description="Read complete reviewed preferences, contexts or examples by ID, "
                 "with versions and linked contexts. Use for maintenance, not activation.")
    def get_preference_records(
        record_ids: RecordIds, expected_persona_revision: Revision = None,
        max_chars: Budget = 24000, cursor: str | None = None,
    ) -> ReadResult:
        return _call("get_preference_records", lambda: service.get_preference_records(
            record_ids=record_ids, expected_persona_revision=expected_persona_revision,
            max_chars=max_chars, cursor=cursor,
        ))
