from __future__ import annotations

import asyncio
import hashlib
import shutil
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from threading import Event

import pytest
from mcp import Client
from persona_fixture import demo_workspace

import ai_persona.proposals as proposals_module
from ai_persona.agent import AgentServiceError, PersonaQueryService, TagScope
from ai_persona.compiler import PersonaCompiler
from ai_persona.frontmatter import dump_markdown_record
from ai_persona.index import search_index
from ai_persona.mcp_server import create_mcp_server
from ai_persona.models import Preference
from ai_persona.proposals import ProposalService
from ai_persona.store import PersonaStore

PHYSICS = TagScope(tag_ids=["tag_physics"])
AI = TagScope(tag_ids=["tag_ai"])


@pytest.fixture
def workspace(tmp_path: Path) -> tuple[Path, Path, PersonaQueryService]:
    data = tmp_path / "persona-data"
    state = tmp_path / "persona-state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    return data, state, PersonaQueryService(data, state)


def edit(data: Path, record_id: str, **changes) -> None:
    loaded = PersonaStore(data).load().records[record_id]
    payload = loaded.record.model_dump(mode="json", by_alias=True)
    payload.update(changes)
    loaded.path.write_text(dump_markdown_record(payload, loaded.body), encoding="utf-8")


def clone(data: Path, template_id: str, record_id: str, **changes) -> None:
    loaded = PersonaStore(data).load().records[template_id]
    payload = loaded.record.model_dump(mode="json", by_alias=True)
    payload.update(id=record_id, **changes)
    (loaded.path.parent / f"{record_id}.md").write_text(
        dump_markdown_record(payload, ""), encoding="utf-8"
    )


def assert_error(code, operation, **kwargs) -> None:
    with pytest.raises(AgentServiceError) as error:
        operation(**kwargs)
    assert error.value.code == code


def test_tag_discovery_normalizes_names_and_keeps_ambiguity(workspace):
    data, _, service = workspace
    clone(data, "tag_physics", "tag_other_physics", slug="other-physics", label="Other physics")
    clone(data, "tag_physics", "tag_old_physics", slug="old-physics", status="archived")
    tags = service.list_tags(query=" ＰＨＹＳＩＣＳ ")
    assert {tag.id for tag in tags.tags} == {"tag_physics", "tag_other_physics"}
    assert all(tag.match_kind == "exact" for tag in tags.tags)  # Shared alias is ambiguous.
    assert service.list_tags(query="物理学").total_count == 1
    assert service.list_tags(query="人工智能").tags[0].id == "tag_ai"
    assert all(tag.namespace == "domain" for tag in service.list_tags().tags)
    assert service.list_tags(namespace=None).total_count > service.list_tags().total_count
    first = service.list_tags(limit=1)
    second = service.list_tags(limit=1, cursor=first.next_cursor)
    assert first.tags[0].id != second.tags[0].id
    assert_error("cursor_expired", service.list_tags, namespace=None, cursor=first.next_cursor)


def test_scope_empty_unknown_and_legacy_semantics(workspace):
    _, _, service = workspace
    empty = TagScope(tag_ids=[])
    assert service.search_knowledge(scope=empty).results == []
    assert service.search_knowledge(query="TEBD", scope=empty).total_count == 0
    assert service.search_knowledge(query="TEBD", tag_ids=[]).results
    assert_error("invalid_reference", service.search_knowledge, scope={"tag_ids": ["tag_missing"]})
    assert_error("invalid_request", service.search_knowledge, scope=PHYSICS, tag_ids=[])
    prepared = service.prepare_persona_context(task="Write a note", scope=empty)
    assert prepared.knowledge == prepared.preferences == prepared.examples == []
    assert prepared.matched_contexts == prepared.unknowns == []
    assert prepared.guidance.explanation_depth == "no_assumption"
    assert prepared.coverage.scope_record_count == prepared.coverage.returned_count == 0
    assert_error("out_of_scope", service.get_persona_record, record_id="kn_demo_tebd", scope=empty)


def test_any_and_all_tag_scopes(workspace):
    data, state, service = workspace
    edit(data, "kn_demo_tebd", tags=["tag_physics", "tag_ai"])
    edit(data, "kn_demo_mps", tags=["tag_ai"])
    PersonaCompiler(data, state).build()
    all_scope = TagScope(tag_ids=["tag_physics", "tag_ai"])
    assert [r.id for r in service.search_knowledge(scope=all_scope).results] == ["kn_demo_tebd"]
    any_scope = TagScope(tag_ids=all_scope.tag_ids, tag_match="any")
    results = service.search_knowledge(scope=any_scope, limit=50)
    assert {"kn_demo_tebd", "kn_demo_mps", "crs_demo_advanced_qm"} <= {
        r.id for r in results.results
    }
    assert results.total_count > 1
    legacy = service.search_knowledge(tag_ids=all_scope.tag_ids)
    assert [r.id for r in legacy.results] == ["kn_demo_tebd"]


def test_scoped_reads_exclude_global_preferences(workspace):
    data, state, service = workspace
    store = PersonaStore(data).load()
    base = store.records["tag_physics"].record
    preference = Preference(
        schema="ai-persona.preference/v1",
        entity_type="preference",
        id="pref_scope_test",
        status="active",
        revision=1,
        created_at=base.created_at,
        updated_at=base.updated_at,
        behavior="required",
        instruction="GLOBAL PREFERENCE MUST NOT ENTER PHYSICS",
    )
    pref_dir = data / "records" / "preferences"
    pref_dir.mkdir(parents=True, exist_ok=True)
    (pref_dir / "pref_scope_test.md").write_text(
        dump_markdown_record(preference.model_dump(mode="json", by_alias=True), ""),
        encoding="utf-8",
    )
    PersonaCompiler(data, state).build()
    assert service.prepare_persona_context(task="Write a note").preferences
    prepared = service.prepare_persona_context(task="Write a note", scope=PHYSICS)
    assert prepared.preferences == prepared.examples == prepared.matched_contexts == []
    assert "unscoped_preferences_excluded" in prepared.coverage.omission_reasons
    assert_error("out_of_scope", service.get_persona_record, record_id=preference.id, scope=PHYSICS)


def test_relationships_and_evidence_stay_inside_scope(workspace):
    data, state, service = workspace
    edit(data, "kn_demo_mps", tags=["tag_ai"])
    # An eligible node reachable only through the excluded MPS must stay unreachable.
    clone(data, "kn_demo_tebd", "kn_scoped_island", title="Scoped island", evidence_refs=[])
    clone(data, "rel_demo_tebd_requires_mps", "rel_scope_bridge", source_id="kn_scoped_island")
    PersonaCompiler(data, state).build()
    search = service.search_knowledge(query="TEBD", scope=PHYSICS, include_evidence=True)
    tebd = next(r for r in search.results if r.id == "kn_demo_tebd")
    assert "kn_demo_mps" not in {hint.other_id for hint in tebd.relation_hints}
    assert tebd.evidence == []  # Declaration Source is not an in-scope Material.
    detail = service.get_persona_record(record_id=tebd.id, scope=PHYSICS, include_evidence=True)
    assert detail.record["data"]["evidence_refs"] == []
    assert all("kn_demo_mps" not in (r["source_id"], r["target_id"]) for r in detail.relations)
    assert all("ev_demo_declaration" not in r["evidence_refs"] for r in detail.relations)
    related = service.search_knowledge(related_to=tebd.id, max_distance=10, scope=PHYSICS, limit=50)
    assert "kn_scoped_island" not in {r.id for r in related.results}
    assert "kn_scoped_island" in {
        r.id
        for r in service.search_knowledge(related_to=tebd.id, max_distance=10, limit=50).results
    }
    assert_error("out_of_scope", service.search_knowledge, related_to="kn_demo_mps", scope=PHYSICS)
    material = service.get_persona_record(
        record_id="mat_demo_tebd_note", scope=PHYSICS, include_evidence=True
    )
    assert [e.id for e in material.evidence] == ["ev_demo_note"]
    assert_error(
        "out_of_scope", service.get_persona_record, record_id="ev_demo_note", scope=PHYSICS
    )


def test_material_metadata_and_version_checked_original(workspace):
    data, state, service = workspace
    edit(data, "kn_demo_tebd", interest_level="medium", knowledge_level="unspecified")
    edit(
        data,
        "mat_demo_tebd_note",
        bibliography={"authors": ["Fixture Author"], "identifiers": {"arxiv": "2501.12903"}},
    )
    PersonaCompiler(data, state).build()
    results = service.search_knowledge(scope=PHYSICS, limit=50)
    material = next(r for r in results.results if r.id == "mat_demo_tebd_note")
    tebd = next(r for r in results.results if r.id == "kn_demo_tebd")
    assert tebd.interest_level == "medium" and tebd.knowledge_level == "unspecified"
    assert "authored" in material.user_relationships
    assert material.bibliography["identifiers"]["arxiv"] == "2501.12903"
    assert material.source.has_text is True
    args = dict(
        material_id=material.id,
        scope=PHYSICS,
        expected_persona_revision=results.persona_revision,
        expected_record_revision=material.record_revision,
        expected_source_hash=material.source.source_hash,
    )
    source = service.get_material_source(**args)
    assert source.source_hash == material.source.source_hash
    for file in source.files:
        assert file.sha256 == "sha256:" + hashlib.sha256(Path(file.path).read_bytes()).hexdigest()
    assert_error("out_of_scope", service.get_material_source, **{**args, "scope": AI})
    assert_error(
        "stale_source",
        service.get_material_source,
        **{**args, "expected_source_hash": "sha256:" + "0" * 64},
    )
    assert_error(
        "stale_record", service.get_material_source, **{**args, "expected_record_revision": 999}
    )
    assert_error(
        "stale_record",
        service.get_persona_record,
        record_id=tebd.id,
        scope=PHYSICS,
        expected_record_revision=999,
    )


def test_filtering_precedes_global_top_100_and_pagination_is_complete(workspace):
    data, state, service = workspace
    template = PersonaStore(data).load().records["kn_demo_tebd"]
    payload = template.record.model_dump(mode="json", by_alias=True)
    payload.update(
        title="ScopeRankingProbe", aliases=[], summary="", scope_note="", evidence_refs=[]
    )
    for i in range(110):
        payload.update(id=f"kn_ranking_{i:03d}", tags=["tag_ai"])
        (template.path.parent / f"{payload['id']}.md").write_text(
            dump_markdown_record(payload, ""), encoding="utf-8"
        )
    payload.update(id="kn_ranking_physics", tags=["tag_physics"], summary="padding " * 300)
    (template.path.parent / "kn_ranking_physics.md").write_text(
        dump_markdown_record(payload, ""), encoding="utf-8"
    )
    PersonaCompiler(data, state).build()
    assert "kn_ranking_physics" not in {
        r["id"] for r in search_index(state, "ScopeRankingProbe", limit=100)
    }
    scoped = service.search_knowledge(query="ScopeRankingProbe", scope=PHYSICS)
    assert [r.id for r in scoped.results] == ["kn_ranking_physics"]
    ids, cursor = [], None
    while True:
        page = service.search_knowledge(
            query="ScopeRankingProbe", scope=AI, limit=37, cursor=cursor
        )
        assert page.total_count == 110
        ids.extend(r.id for r in page.results)
        cursor = page.next_cursor
        if cursor is None:
            break
    assert len(ids) == len(set(ids)) == 110


@pytest.mark.parametrize(
    "changed",
    [
        {"query": "MPS"},
        {"scope": AI},
        {"entity_types": ["material"]},
        {"scope": TagScope(tag_ids=["tag_physics"], tag_match="any")},
        {"include_evidence": True},
    ],
)
def test_cursor_is_bound_to_every_query_filter(workspace, changed):
    _, _, service = workspace
    args = dict(scope=PHYSICS, limit=1)
    page = service.search_knowledge(**args)
    assert page.next_cursor
    assert_error(
        "cursor_expired",
        service.search_knowledge,
        **{**args, **changed, "cursor": page.next_cursor},
    )


def test_cursor_normalizes_tag_order(workspace):
    _, _, service = workspace
    scope = TagScope(tag_ids=["tag_physics", "tag_tensor_network"])
    first = service.search_knowledge(scope=scope, limit=1)
    next_page = service.search_knowledge(
        scope=TagScope(tag_ids=list(reversed(scope.tag_ids))), limit=1, cursor=first.next_cursor
    )
    assert next_page.results[0].id != first.results[0].id


def test_published_tag_change_invalidates_old_reads_and_cursors(workspace):
    data, state, service = workspace
    old = service.search_knowledge(scope=PHYSICS, limit=1)
    tags = service.list_tags(limit=1)
    proposals = ProposalService(data, state)
    pending = proposals.create_update("mat_demo_tebd_note", {"tags": ["tag_ai"]})
    assert service.get_material_source(material_id="mat_demo_tebd_note", scope=PHYSICS)
    proposals.accept(pending.id)
    for operation, arguments in [
        (service.list_tags, {}),
        (service.search_knowledge, {"scope": PHYSICS}),
        (service.prepare_persona_context, {"task": "Recommend", "scope": PHYSICS}),
        (service.get_persona_record, {"record_id": "mat_demo_tebd_note", "scope": PHYSICS}),
        (service.get_material_source, {"material_id": "mat_demo_tebd_note", "scope": PHYSICS}),
    ]:
        assert_error(
            "stale_revision", operation, **arguments, expected_persona_revision=old.persona_revision
        )
    assert_error("cursor_expired", service.search_knowledge, scope=PHYSICS, cursor=old.next_cursor)
    assert_error("cursor_expired", service.list_tags, cursor=tags.next_cursor)
    assert_error(
        "out_of_scope", service.get_material_source, material_id="mat_demo_tebd_note", scope=PHYSICS
    )
    changes = service.list_persona_changes(since_revision=old.persona_revision)
    assert "mat_demo_tebd_note" in {c.object_id for c in changes.changes}
    history = service.list_persona_changes(since_revision=0, limit=1)
    assert history.next_cursor
    assert_error(
        "cursor_expired", service.list_persona_changes, since_revision=1, cursor=history.next_cursor
    )


def test_context_uses_one_snapshot_and_exposes_coverage(workspace, monkeypatch):
    _, _, service = workspace
    original = PersonaStore.load
    calls = []

    def counted(store):
        calls.append(store)
        return original(store)

    monkeypatch.setattr(PersonaStore, "load", counted)
    legacy = service.prepare_persona_context(task="Write", question="TEBD")
    assert len(calls) == 1 and legacy.knowledge
    calls.clear()
    prepared = service.prepare_persona_context(task="Recommend", scope=PHYSICS, knowledge_limit=1)
    assert len(calls) == 1
    assert prepared.coverage.scope_record_count == prepared.coverage.matched_count
    assert prepared.coverage.returned_count == 1
    assert "candidate_limit" in prepared.coverage.omission_reasons
    small = service.prepare_persona_context(
        task="Recommend", scope=PHYSICS, knowledge_limit=50, max_chars=1000
    )
    assert small.budget.used_chars <= 1000 and small.budget.truncated
    assert "character_budget" in small.coverage.omission_reasons
    assert small.coverage.returned_count == len(small.knowledge) < small.coverage.matched_count


def test_publication_waits_until_the_whole_query_finishes(workspace, monkeypatch):
    data, state, service = workspace
    proposals = ProposalService(data, state)
    pending = proposals.create_update("mat_demo_tebd_note", {"tags": ["tag_ai"]})
    reading, release_read, publishing, acquired = Event(), Event(), Event(), Event()
    original_projection = service._knowledge_result
    original_lock = proposals_module.proposal_lock

    def paused_projection(*args, **kwargs):
        reading.set()
        assert release_read.wait(5)
        return original_projection(*args, **kwargs)

    @contextmanager
    def observed_publication_lock(root):
        publishing.set()
        with original_lock(root):
            acquired.set()
            yield

    monkeypatch.setattr(service, "_knowledge_result", paused_projection)
    monkeypatch.setattr(proposals_module, "proposal_lock", observed_publication_lock)
    with ThreadPoolExecutor(max_workers=2) as pool:
        reader = pool.submit(service.search_knowledge, scope=PHYSICS, limit=50)
        assert reading.wait(5)
        writer = pool.submit(proposals.accept, pending.id)
        try:
            assert publishing.wait(5)
            assert not acquired.wait(0.05)
        finally:
            release_read.set()
        before = reader.result(timeout=5)
        writer.result(timeout=5)
    assert "mat_demo_tebd_note" in {r.id for r in before.results}
    after = service.search_knowledge(scope=PHYSICS, limit=50)
    assert after.persona_revision == before.persona_revision + 1
    assert "mat_demo_tebd_note" not in {r.id for r in after.results}


def test_mcp_validates_scope_and_supports_discovery_to_read_flow(workspace):
    data, state, _ = workspace

    async def scenario():
        async with Client(create_mcp_server(data, state)) as client:
            listed = await client.list_tools()
            for tool in listed.tools:
                if tool.name in {"get_knowledge_map", "search_knowledge", "get_persona_records",
                                 "list_source_files", "search_source_content", "read_source"}:
                    assert tool.input_schema["$defs"]["TagScope"]["additionalProperties"] is False
                    assert tool.output_schema is not None
            discovered = await client.call_tool("get_knowledge_map", {})
            result = discovered.structured_content
            domain = next(t for t in result["data"]["domains"] if t["id"] == "tag_physics")
            prepared = await client.call_tool("search_knowledge", {
                "query": "TEBD", "scope": {"tag_ids": [domain["id"]]},
                "expected_persona_revision": result["persona_revision"],
            })
            assert prepared.structured_content["data"]["hits"]
            bad = await client.call_tool("search_knowledge", {
                "scope": {"tag_ids": [], "allow_global": True}})
            assert bad.is_error
            stale = await client.call_tool("list_source_files", {
                "source_id": "src_demo_note", "expected_persona_revision": 999})
            assert stale.is_error
            assert stale.structured_content["error"]["code"] == "version_changed"

    asyncio.run(scenario())
