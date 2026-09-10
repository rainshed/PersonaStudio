from __future__ import annotations

import json
import re
import shutil
import unicodedata
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace
from pydantic import ValidationError

from ai_persona.compiler import PersonaCompiler
from ai_persona.models import ChangeProposal
from ai_persona.proposals import ProposalError, ProposalService
from ai_persona.review import proposal_presentation
from ai_persona.store import PersonaStore
from ai_persona.web import _graph_layout, _graph_title_lines, create_app


@pytest.fixture
def workspace(tmp_path):
    data, state = tmp_path / "data", tmp_path / "state"
    demo = demo_workspace().data_root
    assert demo is not None
    shutil.copytree(demo, data)
    PersonaCompiler(data, state).build()
    return data, ProposalService(data, state), TestClient(create_app(data, state))


def submit(client, service, route, values):
    before_pending = service.repository.list_pending()
    response = client.post(route, data=values, follow_redirects=False)
    assert response.status_code == 303
    assert "kind=success" in response.headers["location"]
    assert not response.headers["location"].startswith("/review")
    assert service.repository.list_pending() == before_pending
    ledger = json.loads((service.data_root / "revisions/changes.jsonl").read_text().splitlines()[-1])
    proposal_id = ledger["proposal_ids"][0]
    return service.repository.get(proposal_id)


def projected(client, proposal):
    response = client.get(f"/api/inbox/v1/items/proposal:{proposal.id}/review")
    assert response.status_code == 200, response.text
    return next(p for p in response.json()["proposals"] if p["id"] == proposal.id)


@pytest.mark.parametrize("route,values,action", [
    ("/knowledge/proposals", {"title": "Krylov knowledge", "semantic_role": "method",
      "interest_level": "unspecified", "summary": "A subspace approximation."}, "新增知识点"),
    ("/courses/proposals", {"title": "Krylov course", "interest_level": "unspecified"}, "新增课程"),
    ("/materials/proposals", {"title": "Krylov paper", "source_mode": "paste",
      "source_text": "# Krylov paper\n\nSubspace approximation.", "material_type": "paper",
      "relationships": "read", "preference_level": "unspecified"}, "新增材料"),
    ("/preferences/contexts/proposals",
     {"name": "研究写作", "description": "研究笔记与文稿"}, "新增偏好场景"),
    ("/preferences/proposals",
     {"scope": "global", "behavior": "preferred", "instruction": "先给出推导路线"}, "新增偏好"),
    ("/knowledge/kn_demo_tebd/proposals",
     {"title": "TEBD revised", "semantic_role": "technique", "interest_level": "high",
      "knowledge_level": "familiar", "summary": "A tensor network time evolution method."},
     "修改知识点"),
    ("/materials/mat_demo_tebd_note/evidence-proposals", {"line_start": "1", "line_end": "1"},
     "新增证据"),
    ("/materials/mat_demo_tebd_note/source-proposals",
     {"source_mode": "paste", "source_text": "# Revised TEBD\n\nCorrected notes.",
      "material_type": "note"}, "修改材料"),
])
def test_human_forms_publish_without_a_reason(workspace, route, values, action):
    data, service, client = workspace
    proposal = submit(client, service, route, values)
    assert proposal.reason == ""
    assert proposal.submitted_by == "human"
    page = client.get(f"/review/{proposal.id}")
    assert page.status_code == 200
    result = projected(client, proposal)
    assert result["presentation"]["action"] == action
    assert "confidence-ring" not in page.text
    assert "confidence" not in result
    # Graph zoom includes percentages; model confidence remains absent from the review projection.
    assert "confidence" not in result
    assert proposal.status == "accepted"
    assert proposal.decision_source == "human_edit"
    assert service.repository.get(proposal.id).status == "accepted"
    assert proposal.target_id in PersonaStore(data).load().records
    ledger = json.loads((data / "revisions/changes.jsonl").read_text().splitlines()[-1])
    assert ledger["note"] == ""
    assert ledger["proposal_ids"] == [proposal.id]
    history = client.get("/review")
    assert history.url.path == "/inbox"
    assert not client.get("/api/inbox/v1/items?view=review").json()["items"]
    assert client.get("/").status_code == 200


@pytest.mark.parametrize("reason", ["", " \n "])
def test_ai_requires_rationale_but_human_reason_is_optional(workspace, reason):
    _, service, _ = workspace
    values = {"title": "Krylov", "semantic_role": "method", "interest_level": "unspecified"}
    with pytest.raises(ProposalError, match="AI proposals require a reason"):
        service.create_record("knowledge_node", values, submitted_by="ai", reason=reason)
    with pytest.raises(ProposalError, match="AI proposals require a reason"):
        service.create_update("kn_demo_tebd", {"summary": "Revised"}, submitted_by="ai", reason=reason)
    human = service.create_record("knowledge_node", values, reason=reason)
    payload = human.model_dump(mode="json", by_alias=True)
    payload.pop("reason")
    assert ChangeProposal.model_validate(payload).reason == ""
    payload["submitted_by"] = "ai"
    with pytest.raises(ValidationError, match="AI proposals require a reason"):
        ChangeProposal.model_validate(payload)
    payload["reason"] = "The supplied note explicitly describes the method."
    assert ChangeProposal.model_validate(payload).submitted_by == "ai"


def test_review_labels_distinguish_objects_and_preserve_existing_content(workspace):
    data, service, client = workspace
    knowledge = service.create_update("kn_demo_tebd", {"summary": "Concept explanation"})
    material = service.create_update("mat_demo_tebd_note", {"summary": "Article content summary"})
    old = PersonaStore(data).load().records["kn_demo_tebd"].record.summary
    for locale, description, mastery, notes, summary in [
        ("zh-CN", "知识说明", "掌握范围", "个人笔记", "内容摘要"),
        ("en", "Knowledge explanation", "Scope of mastery", "Personal notes", "Content summary"),
    ]:
        client.cookies.set("ai_persona_locale", locale)
        for path in ["/knowledge/new", "/knowledge/kn_demo_tebd/edit",
                     "/knowledge/kn_demo_tebd"]:
            page = client.get(path)
            assert page.status_code == 200
            assert description in page.text
            assert notes in page.text
            assert mastery in page.text
        labels = {f["label"] for f in projected(client, knowledge)["fields"]}
        assert {description, mastery, notes} <= labels
        assert summary in {f["label"] for f in projected(client, material)["fields"]}
        for path in ["/materials/new", "/materials/mat_demo_tebd_note"]:
            assert summary in client.get(path).text
    assert PersonaStore(data).load().records["kn_demo_tebd"].record.summary == old


def test_knowledge_map_is_primary_and_exposes_interest_and_relation_encodings(workspace):
    _, _, client = workspace
    page = client.get("/knowledge")
    assert page.status_code == 200
    html = page.text
    assert html.index('id="graph"') < html.index('id="knowledge-list"')
    graph = json.loads(re.search(
        r'<script type="application/json" data-graph-data>(.*?)</script>', html, re.S,
    ).group(1))
    assert any(node["interest"] == "high" for node in graph["nodes"])
    assert {"broader_than", "requires", "applied_in"} <= {
        edge["type"] for edge in graph["edges"]
    }
    assert 'class="relation-legend"' in html
    assert all(node["href"].startswith("/knowledge/") for node in graph["nodes"])


def test_graph_layout_places_contextual_methods_with_their_application_tree():
    nodes = [
        SimpleNamespace(id="kn_domain", title="Domain", semantic_role="domain"),
        SimpleNamespace(id="kn_topic", title="Topic", semantic_role="topic"),
        SimpleNamespace(id="kn_method", title="Method", semantic_role="method"),
        SimpleNamespace(id="kn_other", title="Other area", semantic_role="area"),
    ]
    for node in nodes:
        node.knowledge_level = "unspecified"
        node.interest_level = "unspecified"
    relations = [
        SimpleNamespace(
            id="rel_hierarchy",
            relation_type="broader_than",
            source_id="kn_domain",
            target_id="kn_topic",
        ),
        SimpleNamespace(
            id="rel_application",
            relation_type="applied_in",
            source_id="kn_method",
            target_id="kn_topic",
        ),
    ]

    class FakeStore:
        def of_type(self, model, *, active_only):
            assert active_only is True
            return nodes if model.__name__ == "KnowledgeNode" else relations

    graph = _graph_layout(FakeStore())
    positions = {item["record"].id: item for item in graph["nodes"]}
    assert positions["kn_method"]["cluster"] == "tree:kn_domain"
    assert positions["kn_method"]["anchors"] == ["kn_topic"]
    assert positions["kn_method"]["x"] > positions["kn_topic"]["x"]
    assert positions["kn_other"]["cluster"] == "related:kn_other"
    assert next(g for g in graph["clusters"] if g["index"] == "related:kn_other")["title"] == "Other area"
    assert positions["kn_domain"]["cluster"] == "tree:kn_domain"
    assert len(graph["clusters"]) == 2
    first, second = sorted(graph["clusters"], key=lambda item: item["x"])
    assert second["x"] - (first["x"] + first["width"]) >= 40
    # Each group can be opened independently without clipping its cards.
    for item in graph["nodes"]:
        cluster = next(group for group in graph["clusters"] if group["index"] == item["cluster"])
        assert cluster["x"] <= item["x"]
        assert cluster["y"] + 40 <= item["y"]
        assert item["x"] + item["width"] <= cluster["x"] + cluster["width"]
        assert item["y"] + item["height"] <= cluster["y"] + cluster["height"]
    assert sum(cluster["count"] for cluster in graph["clusters"]) == len(nodes)
    assert positions["kn_domain"]["is_root"] is True
    assert positions["kn_method"]["is_root"] is False


@pytest.mark.parametrize("title", [
    "非平衡量子多体系统中的超扩散输运与反常热化现象的理论方法与数值模拟研究",
    "Quantum 多体系统的非平衡动力学与 Tensor network methods",
    "A_very_long_unbroken_concept_identifier_that_cannot_fit_in_one_card",
])
def test_graph_titles_fit_two_lines_for_latin_and_cjk_text(title):
    lines = _graph_title_lines(title, width=27)
    assert len(lines) == 2
    for line in lines:
        assert sum(2 if unicodedata.east_asian_width(char) in {"W", "F"} else 1
                   for char in line) <= 27
    assert lines[-1].endswith("…")


def test_graph_titles_keep_short_names_and_normalize_whitespace():
    assert _graph_title_lines("量子动力学") == ["量子动力学"]
    assert _graph_title_lines("Quantum\n  dynamics") == ["Quantum dynamics"]
    assert _graph_title_lines("") == [""]


def test_graph_layout_prefers_short_uncrossed_parent_child_edges():
    def node(node_id, title, role):
        return SimpleNamespace(
            id=node_id,
            title=title,
            semantic_role=role,
            knowledge_level="unspecified",
            interest_level="unspecified",
        )

    nodes = [
        node("kn_root", "Root", "domain"),
        node("kn_left", "A parent", "area"),
        node("kn_right", "Z parent", "area"),
        node("kn_left_child", "Z child", "concept"),
        node("kn_right_child", "A child", "concept"),
    ]
    relations = [
        SimpleNamespace(id="rel_1", relation_type="broader_than", source_id="kn_root", target_id="kn_left"),
        SimpleNamespace(id="rel_2", relation_type="broader_than", source_id="kn_root", target_id="kn_right"),
        SimpleNamespace(id="rel_3", relation_type="broader_than", source_id="kn_left", target_id="kn_left_child"),
        SimpleNamespace(id="rel_4", relation_type="broader_than", source_id="kn_right", target_id="kn_right_child"),
    ]

    class FakeStore:
        def of_type(self, model, *, active_only):
            assert active_only is True
            return nodes if model.__name__ == "KnowledgeNode" else relations

    positions = {
        item["record"].id: item for item in _graph_layout(FakeStore())["nodes"]
    }
    parent_order = positions["kn_left"]["x"] - positions["kn_right"]["x"]
    child_order = positions["kn_left_child"]["x"] - positions["kn_right_child"]["x"]
    assert parent_order * child_order > 0


def test_graph_layout_omits_redundant_transitive_hierarchy_edges():
    nodes = [
        SimpleNamespace(
            id=node_id,
            title=node_id,
            semantic_role="concept",
            knowledge_level="unspecified",
            interest_level="unspecified",
        )
        for node_id in ("kn_root", "kn_middle", "kn_leaf")
    ]
    relations = [
        SimpleNamespace(id="rel_1", relation_type="broader_than", source_id="kn_root", target_id="kn_middle"),
        SimpleNamespace(id="rel_2", relation_type="broader_than", source_id="kn_middle", target_id="kn_leaf"),
        SimpleNamespace(id="rel_redundant", relation_type="broader_than", source_id="kn_root", target_id="kn_leaf"),
    ]

    class FakeStore:
        def of_type(self, model, *, active_only):
            assert active_only is True
            return nodes if model.__name__ == "KnowledgeNode" else relations

    graph = _graph_layout(FakeStore())
    assert graph["relation_counts"]["broader_than"] == 2
    assert {edge["id"] for edge in graph["edges"]} == {"rel_1", "rel_2"}


def test_queue_types_and_proposed_titles_are_per_proposal(workspace):
    _, service, client = workspace
    first = service.create_update("kn_demo_tebd", {"title": "Title A"})
    second = service.create_update("kn_demo_tebd", {"title": "Title B"},
                                   submitted_by="ai", reason="Match the supplied source title.")
    course = service.create_record("course", {"title": "Course C", "interest_level": "unspecified"})
    paper = submit(client, service, "/materials/proposals", {
        "title": "Paper D", "source_mode": "paste", "source_text": "# Paper D",
        "material_type": "paper", "relationships": "read", "preference_level": "unspecified",
    })
    # Older updates may not include the type; resolve it from the official record.
    service.repository.save_pending(first.model_copy(update={"target_entity_type": None}))
    queue = client.get("/api/inbox/v1/items?view=review").json()
    assert queue["pending_count"] == 3
    for proposal, title in [(first, "Title A"), (second, "Title B"), (course, "Course C"), (paper, "Paper D")]:
        assert projected(client, proposal)["title"] == title
    assert projected(client, first)["presentation"]["action"] == "修改知识点"
    assert projected(client, course)["presentation"]["action"] == "新增课程"
    assert projected(client, paper)["presentation"]["subtype"] == "论文"
    assert projected(client, second)["note"] == second.reason


def test_manual_notes_collapsed_and_optional_across_forms(workspace):
    _, _, client = workspace
    paths = ["/knowledge/new", "/courses/new", "/materials/new", "/knowledge/kn_demo_tebd/edit",
             "/knowledge/kn_demo_tebd", "/materials/mat_demo_tebd_note",
             "/materials/mat_demo_tebd_note/edit", "/materials/mat_demo_tebd_note/source/edit",
             "/materials/mat_demo_tebd_note/source-text",
             "/preferences/new",
             "/preferences/examples/new"]
    for path in paths:
        page = client.get(path)
        assert page.status_code == 200, path
        details = re.findall(r'<details class="optional-note[^>]*>.*?</details>', page.text, re.S)
        assert details, path
        for note in details:
            assert "添加备注（可选）" in note
            assert "required" not in note
            assert "open" not in note.split(">", 1)[0]


def test_reviewed_changes_drive_history_without_a_note(workspace):
    data, service, client = workspace
    new = service.create_record("knowledge_node", {
        "title": "Krylov", "semantic_role": "method", "interest_level": "unspecified",
    })
    service.accept(new.id)
    update = service.create_update(new.target_id, {"knowledge_level": "aware"})
    response = client.post(f"/review/{update.id}/edit-and-accept", data={
        "proposal_revision": update.proposal_revision, "knowledge_level": "familiar",
        "summary": "Low dimensional approximation of a matrix problem.",
    }, follow_redirects=False)
    assert response.status_code == 303
    final = service.repository.get(update.id)
    assert final.status == "edited_and_accepted"
    assert final.decision_reason is None
    assert final.reason == ""
    store = PersonaStore(data).load()
    presentation = proposal_presentation(final, store, "zh-CN")
    assert "未设置 → 熟悉" in presentation["summary"]
    assert "修改知识说明" in presentation["summary"]
    assert projected(client, final)["presentation"]["summary"] == presentation["summary"]
    assert presentation["summary"] in client.get("/").text
    # Later changes must not rewrite the meaning of the earlier publication.
    later = service.create_update(new.target_id, {"knowledge_level": "proficient"}, reason="后来补充")
    service.accept(later.id)
    assert proposal_presentation(final, PersonaStore(data).load(), "zh-CN")["summary"] == presentation["summary"]
    assert service.repository.get(later.id).reason == "后来补充"


def test_optional_review_note_survives_invalid_form(workspace):
    _, service, client = workspace
    proposal = service.create_update("kn_demo_tebd", {"summary": "Revised explanation"})
    result = client.post(f"/review/{proposal.id}/edit-and-accept", data={
        "proposal_revision": proposal.proposal_revision,
        "title": "", "review_note": "待确认的个人备注",
    })
    assert result.status_code == 422
    assert 'class="optional-note wide" open' in result.text
    assert "待确认的个人备注" in result.text
    assert service.repository.get(proposal.id).status == "pending_review"


def test_relations_archive_restore_without_a_reason(workspace):
    data, service, client = workspace
    new = service.create_record("knowledge_node", {
        "title": "Krylov", "semantic_role": "method", "interest_level": "unspecified",
    })
    service.accept(new.id)
    relation = service.create_relation(new.target_id, "requires", "kn_demo_tebd")
    service.accept(relation.id)
    removal = submit(client, service, f"/relations/{relation.target_id}/remove-proposals", {})
    assert removal.status == "accepted"
    material_relation = service.create_material_relation("mat_demo_tebd_note", new.target_id,
        knowledge_role="mentioned", salience="mentioned", statement="This note mentions Krylov.")
    pending_page = client.get("/materials/mat_demo_tebd_note")
    summary = proposal_presentation(material_relation, PersonaStore(data).load(), "zh-CN")["summary"]
    assert summary in pending_page.text
    service.accept(material_relation.id)
    update = service.create_update(material_relation.target_id, {"statement": "This note mentions the method."})
    assert "添加备注（可选）" in client.get(
        f"/materials/mat_demo_tebd_note/relations/{material_relation.target_id}/edit"
    ).text
    service.accept(update.id)
    archive = service.create_archive("mat_demo_tebd_note")
    service.accept(archive.id)
    restore = service.create_restore("mat_demo_tebd_note")
    service.accept(restore.id)
    assert PersonaStore(data).load().records["mat_demo_tebd_note"].record.status == "active"
    for proposal in [relation, removal, material_relation, update, archive, restore]:
        assert service.repository.get(proposal.id).reason == ""


def test_proposal_schema_matches_optional_human_and_required_ai_reason(workspace):
    schema = ChangeProposal.model_json_schema(by_alias=True)
    assert "reason" not in schema["required"]
    assert schema["then"]["required"] == ["reason"]
    assert schema["then"]["properties"]["reason"]["pattern"] == r"\S"
    data, _, _ = workspace
    assert json.loads((data / "schemas/change-proposal.v1.schema.json").read_text()) == schema


def test_graph_membership_and_names_survive_new_method_tree_and_context_links():
    def node(identifier, title, role="concept"):
        return SimpleNamespace(id=identifier, title=title, semantic_role=role,
                               knowledge_level="unspecified", interest_level="unspecified")

    def relation(source, target, kind="broader_than"):
        return SimpleNamespace(id=f"rel_{source}_{target}_{kind}", source_id=source,
                               target_id=target, relation_type=kind)

    nodes = [node("physics", "quantum dynamics", "domain"), node("thermal", "Thermalization"),
             node("transport", "Transport"), node("scars", "Scars"), node("pxp", "PXP")]
    relations = [relation("physics", "thermal"), relation("physics", "transport"),
                 relation("thermal", "scars"), relation("scars", "pxp"), relation("transport", "pxp")]

    class FakeStore:
        def of_type(self, model, *, active_only):
            return nodes if model.__name__ == "KnowledgeNode" else relations

    original = _graph_layout(FakeStore())
    nodes.extend([node("methods", "Numerical Method in Many-body physics", "method"),
                  node("ed", "ED", "method"), node("tensor", "Tensor network", "method"),
                  node("levy", "Lévy walk", "model"), node("mixed", "Mixed ETH")])
    relations.extend([relation("methods", "ed"), relation("methods", "tensor"),
                      relation("tensor", "transport", "applied_in"),
                      relation("ed", "mixed", "applied_in"),
                      relation("levy", "transport", "applied_in")])
    updated = _graph_layout(FakeStore())
    groups = {g["index"]: g for g in updated["clusters"]}
    assert set(groups) == {"tree:physics", "tree:methods"}
    assert groups["tree:physics"]["title"] == original["clusters"][0]["title"]
    assert groups["tree:physics"]["count"] == 6
    assert groups["tree:methods"]["count"] == 4
    positions = {n["record"].id: n for n in updated["nodes"]}
    assert positions["mixed"]["contextual"] is True
    assert positions["mixed"]["groups"] == ["tree:methods"]
    assert positions["levy"]["groups"] == ["tree:physics"]
    assert positions["levy"]["is_root"] is False
    assert sum(n["record"].id == "pxp" for n in updated["nodes"]) == 1
    assert sum(e["target_id"] == "pxp" for e in updated["edges"]) == 2
    # Adding a cross-topic link doesn't change membership, identity or local layout.
    before = [(n["record"].id, n["cluster"], n["x"], n["y"]) for n in updated["nodes"]]
    relations.append(relation("ed", "physics", "requires"))
    after = _graph_layout(FakeStore())
    assert before == [(n["record"].id, n["cluster"], n["x"], n["y"]) for n in after["nodes"]]
    # Reordering or renaming records never selects a new group identifier.
    nodes.reverse()
    nodes[0].title = "AAA renamed concept"
    assert {g["index"] for g in _graph_layout(FakeStore())["clusters"]} == set(groups)



def test_context_components_can_accompany_multiple_trees_without_merging_them():
    nodes = [SimpleNamespace(id=identifier, title=identifier, semantic_role="concept",
                             knowledge_level="unspecified", interest_level="unspecified")
             for identifier in ["physics", "transport", "numerical", "ed", "tool", "problem"]]
    pairs = [("physics", "transport", "broader_than"), ("numerical", "ed", "broader_than"),
             ("tool", "transport", "applied_in"), ("ed", "problem", "applied_in"),
             ("problem", "tool", "related_to")]
    relations = [SimpleNamespace(id=f"rel_{i}", source_id=a, target_id=b, relation_type=t)
                 for i, (a, b, t) in enumerate(pairs)]

    class FakeStore:
        def of_type(self, model, *, active_only):
            return nodes if model.__name__ == "KnowledgeNode" else relations

    graph = _graph_layout(FakeStore())
    assert {g["title"] for g in graph["clusters"]} == {"physics", "numerical"}
    assert len(graph["nodes"]) == 6  # Shared records appear once in the overview.
    assert [g["count"] for g in graph["clusters"]] == [4, 4]
    for item in graph["nodes"]:
        if item["record"].id in {"tool", "problem"}:
            assert set(item["groups"]) == {"tree:physics", "tree:numerical"}
            assert set(item["anchors"]) == {"transport", "ed"}
            assert not item["is_root"]
    assert graph["relation_counts"]["broader_than"] == 2
