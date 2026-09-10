from __future__ import annotations

import asyncio
import base64
import io
import shutil

import pytest
from mcp import Client
from persona_fixture import demo_workspace
from PIL import Image

from ai_persona.agent import AgentServiceError
from ai_persona.frontmatter import dump_markdown_record
from ai_persona.materials import SourceAttachment, publish_staged_source, stage_source
from ai_persona.mcp_server import create_mcp_server
from ai_persona.models import PreferenceContext, PreferenceExample, Relation
from ai_persona.preference_application.context import resource_for
from ai_persona.preference_sources import stage_folder_source
from ai_persona.query_contracts import encoded, pack, unpack
from ai_persona.query_service import KnowledgeQueryService
from ai_persona.store import PersonaStore


class NoSemantic:
    signature = "test-no-semantic"

    def rank(self, query, documents):
        return {}, {"status": "ready", "documents": len(documents)}


@pytest.fixture
def workspace(tmp_path):
    data, state = tmp_path / "persona-data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    return data, state, KnowledgeQueryService(data, state, retriever=NoSemantic())


def edit(data, rid, *, body=None, **values):
    loaded = PersonaStore(data).load().records[rid]
    record = loaded.record.model_dump(mode="json", by_alias=True)
    record.update(values)
    loaded.path.write_text(dump_markdown_record(record, loaded.body if body is None else body))


def sample_for(data, staged):
    publish_staged_source(data, staged.manifest.id)
    store = PersonaStore(data).load()
    timestamp = next(iter(store.records.values())).record.created_at
    context = PreferenceContext(
        schema="ai-persona.preference-context/v1", id="pctx_reader_fixture",
        entity_type="preference_context", status="active", revision=1,
        created_at=timestamp, updated_at=timestamp, key="reader.fixture", name="Reader fixture",
    )
    context_dir = data / "records" / "preference-contexts"
    context_dir.mkdir(exist_ok=True)
    (context_dir / (context.id + ".md")).write_text(
        dump_markdown_record(context.model_dump(mode="json", by_alias=True), ""))
    sample = PreferenceExample(
        schema="ai-persona.preference-example/v3", id="pex_reader_fixture",
        entity_type="preference_example", status="active", revision=1,
        created_at=context.created_at, updated_at=context.updated_at,
        context_refs=[context.id], example_type="positive", title="Reader sample",
        source_ref=staged.manifest.id, content_hash="sha256:" + staged.manifest.content_hash,
    )
    path = data / "records" / "preference-examples" / (sample.id + ".md")
    path.parent.mkdir(exist_ok=True)
    path.write_text(dump_markdown_record(sample.model_dump(mode="json", by_alias=True), ""))
    return sample


def test_map_pagination_preserves_all_nodes_edges_and_personal_states(workspace):
    data, _, service = workspace
    edit(data, "kn_demo_tebd", scope_note="Only interested in practical simulations.")
    nodes, edges, cursor = {}, {}, None
    for _ in range(100):
        page = service.get_knowledge_map(max_chars=6000, cursor=cursor)
        assert len(encoded(page.model_dump(mode="json"))) <= 6000
        for n in page.data["nodes"]:
            assert n["id"] not in nodes
            assert n["provenance"]["record_id"] == n["id"]
            nodes[n["id"]] = n
        for e in page.data["edges"]:
            assert e["id"] not in edges
            edges[e["id"]] = e
            visible = {n["id"] for n in page.data["nodes"] + page.data["frontier"]}
            assert {e["source_id"], e["target_id"]} <= visible
        cursor = page.next_cursor
        if cursor is None:
            break
    assert cursor is None
    store = PersonaStore(data).load()
    assert set(nodes) == {r.record.id for r in store.active_knowledge()}
    assert set(edges) == {r.id for r in store.of_type(Relation, active_only=True)}
    assert nodes["kn_demo_tebd"]["scope_note"] == "Only interested in practical simulations."
    assert nodes["kn_demo_tebd"]["knowledge_level"] == store.records["kn_demo_tebd"].record.knowledge_level
    assert any(n["entity_type"] == "course" for n in nodes.values())


def test_map_local_paths_and_search_filter_only_hits(workspace):
    _, _, service = workspace
    result = service.get_knowledge_map(focus_ids=["kn_demo_tebd"], relation_types=["requires"],
                                      direction="outgoing")
    assert {n["id"] for n in result.data["nodes"]} == {"kn_demo_tebd", "kn_demo_mps"}
    assert all(e["relation_type"] == "requires" for e in result.data["edges"])
    # There is no lexical match, but a caller-specified anchor supplies graph candidates.
    result = service.search_knowledge(query="unmentioned_probe", focus_ids=["kn_demo_tebd"],
                                      entity_types=["material"], max_hops=1)
    assert "mat_demo_tebd_note" in {h["id"] for h in result.data["hits"]}
    assert all(n["entity_type"] == "material" for n in result.data["nodes"]
               if n["retrieval_role"] == "hit")
    assert any(n["entity_type"] == "knowledge_node" for n in result.data["nodes"])
    assert all("graph_expansion" in h["match_reasons"] for h in result.data["hits"])
    only = service.search_knowledge(query="TEBD", focus_ids=["kn_demo_tebd"], focus_mode="only",
                                   relation_types=["requires"], direction="outgoing")
    assert {h["id"] for h in only.data["hits"]} <= {"kn_demo_tebd", "kn_demo_mps"}
    assert "kn_demo_tebd" in {h["id"] for h in only.data["hits"]}


def test_semantic_candidates_do_not_need_lexical_matches(workspace):
    _, _, service = workspace
    class SemanticFixture:
        signature = "fixture"

        def rank(self, query, documents):
            return {"node:kn_demo_mps": 0.9}, {"status": "ready"}
    service.retriever = SemanticFixture()
    result = service.search_knowledge(query="an_unmatched_translation", entity_types=["knowledge_node"])
    assert result.data["hits"][0]["id"] == "kn_demo_mps"
    assert "semantic_related" in result.data["hits"][0]["match_reasons"]
    assert "alias_match" not in result.data["hits"][0]["match_reasons"]


def test_strict_scope_is_applied_to_graph_sources_and_evidence(workspace):
    _, _, service = workspace
    empty = {"tag_ids": []}
    assert service.get_knowledge_map(scope=empty).data["nodes"] == []
    assert service.search_knowledge(query="TEBD", scope=empty).data["hits"] == []
    item = service.get_persona_records(record_ids=["kn_demo_tebd"], scope=empty).data["items"][0]
    assert item["error"]["code"] == "not_found_or_not_visible"
    for operation, args in [
        (service.get_knowledge_map, {"focus_ids": ["kn_demo_tebd"]}),
        (service.list_source_files, {"source_id": "src_demo_note"}),
        (service.search_source_content, {"source_ids": ["src_demo_note"], "query": "TEBD"}),
        (service.read_source, {"evidence_id": "ev_demo_note"}),
    ]:
        with pytest.raises(AgentServiceError, match="available|scope"):
            operation(scope=empty, **args)


def test_cursor_rejects_changed_scope_arguments_and_same_revision_edits(workspace):
    data, _, service = workspace
    result = service.search_knowledge(query="", entity_types=["knowledge_node"], limit=1)
    assert result.next_cursor
    with pytest.raises(AgentServiceError) as exc:
        service.search_knowledge(query="TEBD", cursor=result.next_cursor)
    assert exc.value.code == "invalid_cursor"
    edit(data, "kn_demo_tebd", summary="Changed without a version bump during development.")
    with pytest.raises(AgentServiceError) as exc:
        service.search_knowledge(entity_types=["knowledge_node"], limit=1, cursor=result.next_cursor)
    assert exc.value.code == "invalid_cursor"
    with pytest.raises(AgentServiceError) as exc:
        service.get_knowledge_map(expected_persona_revision=999)
    assert exc.value.code == "version_changed"


def test_record_body_continuation_is_lossless_and_batch_errors_are_local(workspace):
    data, _, service = workspace
    body = "A detailed note containing exact text.\n" * 500
    edit(data, "kn_demo_tebd", body=body)
    expected = PersonaStore(data).load().records["kn_demo_tebd"].body
    chunks, cursor, errors = [], None, []
    for _ in range(100):
        result = service.get_persona_records(record_ids=["kn_demo_tebd", "kn_missing"],
                                             max_chars=4000, cursor=cursor)
        assert len(encoded(result.model_dump(mode="json"))) <= 4000
        chunks.extend(x for x in result.data["items"] if x.get("field") == "body")
        errors.extend(x for x in result.data["items"] if x.get("error"))
        cursor = result.next_cursor
        if cursor is None:
            break
    assert "".join(c["value"] for c in sorted(chunks, key=lambda c: c["offset"])) == expected
    assert errors[0]["id"] == "kn_missing"


def test_source_search_round_trip_hash_binding_and_missing_file_coverage(workspace):
    data, _, service = workspace
    result = service.search_source_content(source_ids=["src_demo_note"], query="TEBD",
                                           context_chars=100)
    match = result.data["matches"][0]
    read = service.read_source(passage_ref=match["passage_ref"])
    assert read.data["text"].startswith(match["text"])
    assert read.data["provenance"]["file_hash"] == match["provenance"]["file_hash"]
    ref = unpack(match["passage_ref"])
    ref["file_hash"] = "0" * 64
    with pytest.raises(AgentServiceError) as exc:
        service.read_source(passage_ref=pack(ref))
    assert exc.value.code == "source_changed"
    path = data / "sources" / "src_demo_note" / "original.md"
    original = path.read_bytes()
    path.write_bytes(b"Modified source")
    assert service.list_source_files(source_id="src_demo_note").data["entries"][0]["parse_status"] == "failed"
    assert service.search_knowledge(query="TEBD").data["hits"]
    path.write_bytes(original)
    path.unlink()
    result = service.search_source_content(source_ids=["src_demo_note"], query="TEBD")
    assert not result.data["matches"]
    assert result.coverage["status"] == "degraded"


def test_folder_sample_browse_csv_and_local_path_rejection(workspace):
    data, _, service = workspace
    staged = stage_folder_source(data, entries=[
        SourceAttachment("references/a.md", b"# Style\nUse open circles.\n", "text/markdown"),
        SourceAttachment("references/tables/sample.csv", b"x,y\n1,2\n3,4\n", "text/csv"),
        SourceAttachment("references/unknown.bin", b"opaque", "application/octet-stream"),
    ])
    sample = sample_for(data, staged)
    resource = resource_for(PersonaStore(data).load(), sample)
    assert resource["source_ref"] == staged.manifest.id
    root = service.list_source_files(source_id=sample.source_ref)
    assert any(e["kind"] == "directory" for e in root.data["entries"])
    files = service.list_source_files(source_id=sample.source_ref, recursive=True).data["entries"]
    csv_file = next(e for e in files if e["relative_path"].endswith("sample.csv"))
    result = service.read_source(source_id=sample.source_ref, file_id=csv_file["file_id"],
                                 view="structured", selector={"range": "A2:B3"})
    assert result.data["rows"] == [["1", "2"], ["3", "4"]]
    search = service.search_source_content(source_ids=[sample.source_ref], query="open circles")
    assert search.data["matches"]
    assert search.coverage["status"] == "degraded"  # archive/binary are explicitly unindexed
    with pytest.raises(AgentServiceError):
        service.list_source_files(source_id=sample.source_ref, directory="../")
    with pytest.raises(AgentServiceError):
        service.read_source(source_id=sample.source_ref, file_id="../../config/persona.toml")
    with pytest.raises(AgentServiceError):
        service.list_source_files(source_id=sample.source_ref, scope={"tag_ids": ["tag_physics"]})


def test_pdf_image_is_an_actual_mcp_content_block_with_page_continuation(workspace, monkeypatch):
    data, state, service = workspace
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "0")
    stream = io.BytesIO()
    first, second = Image.new("RGB", (100, 80), "red"), Image.new("RGB", (100, 80), "blue")
    first.save(stream, format="PDF", save_all=True, append_images=[second])
    staged = stage_source(data, content=stream.getvalue(), filename="sample.pdf",
                          source_type="other", provider="test", media_type="application/pdf")
    sample_for(data, staged)
    file = service.list_source_files(source_id=staged.manifest.id).data["entries"][0]
    assert file["page_count"] == 2

    async def scenario():
        async with Client(create_mcp_server(data, state)) as client:
            response = await client.call_tool("read_source", {
                "source_id": staged.manifest.id, "file_id": file["file_id"], "view": "image",
                "selector": {"pages": [1, 2]}, "max_images": 1,
            })
            assert not response.is_error
            assert response.structured_content["data"]["next_selector"] == {"pages": [2]}
            blocks = [b for b in response.content if b.type == "image"]
            assert len(blocks) == 1
            with Image.open(io.BytesIO(base64.b64decode(blocks[0].data))) as image:
                assert image.getpixel((30, 30))[0] > 200
            second_page = service.read_source(
                source_id=staged.manifest.id, file_id=file["file_id"], view="image",
                selector=response.structured_content["data"]["next_selector"],
            )
            with Image.open(io.BytesIO(second_page._images[0])) as image:
                assert image.getpixel((30, 30))[2] > 200
    asyncio.run(scenario())


def test_source_text_continuation_returns_exact_original(workspace):
    data, _, service = workspace
    text = ("Quoted \"text\" with backslashes \\\\ and Chinese 中文。\n" * 500).encode()
    staged = stage_source(data, content=text, filename="long.txt", source_type="other",
                          provider="test", media_type="text/plain")
    sample_for(data, staged)
    file = service.list_source_files(source_id=staged.manifest.id).data["entries"][0]
    selector, chunks = None, []
    for _ in range(100):
        result = service.read_source(source_id=staged.manifest.id, file_id=file["file_id"],
                                     view="text", max_chars=4000, selector=selector)
        assert len(encoded(result.model_dump(mode="json"))) <= 4000
        chunks.append(result.data["text"])
        selector = result.data["next_selector"]
        if selector is None:
            break
    assert "".join(chunks) == text.decode()


def test_known_name_in_long_question_precedes_incidental_paper_mentions(workspace):
    _, _, service = workspace
    result = service.search_knowledge(query="Explain TEBD for an unfamiliar reader")
    assert result.data["hits"][0]["id"] == "kn_demo_tebd"
    focused = service.search_knowledge(query="unmentioned_probe", focus_ids=["kn_demo_tebd"],
                                      focus_mode="only", relation_types=["requires"])
    anchor = next(h for h in focused.data["hits"] if h["id"] == "kn_demo_tebd")
    assert "focus_anchor" in anchor["match_reasons"]


def test_scoped_graph_and_batch_record_cannot_leak_evidence_supports(workspace):
    data, _, service = workspace
    edit(data, "kn_demo_mps", tags=["tag_ai"])
    scope = {"tag_ids": ["tag_physics"]}
    graph = service.get_knowledge_map(scope=scope, max_chars=80000)
    assert "kn_demo_mps" not in {n["id"] for n in graph.data["nodes"]}
    assert all("ev_demo_declaration" not in e["evidence_refs"] for e in graph.data["edges"])
    scoped = service.get_persona_records(record_ids=["kn_demo_tebd"], scope=scope,
                                         include_evidence=True).data["items"][0]
    assert scoped["record"]["evidence_refs"] == []
    assert scoped["evidence"] == []
    unscoped = service.get_persona_records(record_ids=["kn_demo_tebd"],
                                           include_evidence=True).data["items"][0]
    assert "ev_demo_declaration" in unscoped["record"]["evidence_refs"]
    assert service.read_source(evidence_id="ev_demo_declaration").data["text"]


def test_record_continuation_respects_json_escaping(workspace):
    data, _, service = workspace
    edit(data, "kn_demo_tebd", body=('Quoted "text" \\\\中文\n' * 400))
    chunks, cursor = [], None
    while True:
        result = service.get_persona_records(record_ids=["kn_demo_tebd"], fields=["body"],
                                             max_chars=3000, cursor=cursor)
        assert len(encoded(result.model_dump(mode="json"))) <= 3000
        chunks.extend(item["value"] for item in result.data["items"] if "value" in item)
        cursor = result.next_cursor
        if cursor is None:
            break
    assert "".join(chunks) == PersonaStore(data).load().records["kn_demo_tebd"].body


def test_bad_pdf_and_incompatible_selectors_are_explicit(workspace):
    data, _, service = workspace
    staged = stage_source(data, content=b"not a pdf", filename="broken.pdf",
                          source_type="other", provider="test", media_type="application/pdf")
    sample_for(data, staged)
    file = service.list_source_files(source_id=staged.manifest.id).data["entries"][0]
    assert file["parse_status"] == "failed" and file["error"] == "parse_failed"
    with pytest.raises(AgentServiceError) as exc:
        service.read_source(source_id=staged.manifest.id, file_id=file["file_id"], view="image")
    assert exc.value.code == "parse_failed"
    text = service.list_source_files(source_id="src_demo_note").data["entries"][0]
    with pytest.raises(AgentServiceError) as exc:
        service.read_source(source_id="src_demo_note", file_id=text["file_id"], view="outline",
                            selector={"lines": {"start": 1, "end": 2}})
    assert exc.value.code == "invalid_arguments"
