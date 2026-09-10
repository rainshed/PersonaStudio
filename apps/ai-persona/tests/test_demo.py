from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.cli import main as cli_main
from ai_persona.compiler import PersonaCompiler
from ai_persona.frontmatter import FrontmatterError, load_yaml_text
from ai_persona.i18n import validate_catalogs
from ai_persona.index import prepare_context, search_index
from ai_persona.initialization import InitializationError, initialize_persona
from ai_persona.materials import stage_url_source
from ai_persona.models import (
    Course,
    Evidence,
    KnowledgeNode,
    Material,
    Preference,
    PreferenceContext,
    PreferenceExample,
    Relation,
    Tag,
)
from ai_persona.proposals import ProposalRepository, record_content_hash
from ai_persona.store import PersonaStore, StoreValidationError
from ai_persona.web import create_app
from ai_persona.workspace import resolve_workspace

DEMO_DATA_ROOT = demo_workspace().data_root
assert DEMO_DATA_ROOT is not None


def copy_demo(tmp_path: Path) -> tuple[Path, Path]:
    data_root = tmp_path / "persona-data"
    shutil.copytree(DEMO_DATA_ROOT, data_root)
    state_root = tmp_path / "persona-state"
    return data_root, state_root


def saved_proposal_id(response: object, data_root: Path) -> str:
    location = response.headers["location"]  # type: ignore[attr-defined]
    assert "kind=success" in location
    assert not location.startswith("/review")
    repository = ProposalRepository(data_root)
    assert repository.list_pending() == []
    ledger = json.loads((data_root / "revisions/changes.jsonl").read_text().splitlines()[-1])
    proposal = repository.get(ledger["proposal_ids"][0])
    assert proposal.status == "accepted"
    assert proposal.submitted_by == "human"
    assert proposal.decision_source == "human_edit"
    return proposal.id


def material_form_data(**overrides: object) -> dict[str, object]:
    values: dict[str, object] = {
        "source_mode": "paste",
        "source_text": "# New source\n\nA uniquely searchable source phrase: quench-front-velocity.",
        "material_type": "note",
        "title": "Quench front reading note",
        "aliases": "Front velocity note",
        "authors": "Demo Author",
        "published_at": "2026-09-02",
        "venue": "Personal Research Note",
        "language": "en",
        "arxiv": "2609.12345v1",
        "doi": "",
        "isbn": "",
        "canonical_url": "https://example.com/quench-front",
        "relationships": ["read"],
        "knowledge_level": "familiar",
        "preference_level": "liked",
        "preference_reasons": "研究方向 | 与我关注的非平衡动力学相关。",
        "summary": "记录量子深混后的传播前沿。",
        "scope_note": "理解主要结论，尚未复现数值结果。",
        "body": "# Personal Notes\n\n## Why I saved this\n\n它与我的当前问题直接相关。",
        "tags": ["tag_physics", "tag_ai"],
        "reason": "导入一份已读的研究 Note。",
    }
    values.update(overrides)
    return values


def test_init_creates_an_empty_persona_ready_for_use(tmp_path: Path) -> None:
    workspace_root = tmp_path / "real-persona"
    data_root = workspace_root / "persona-data"
    state_root = workspace_root / "persona-state"

    exit_code = cli_main(
        [
            "init",
            "--workspace",
            str(workspace_root),
            "--persona-id",
            "research-persona",
        ]
    )

    assert exit_code == 0
    store = PersonaStore(data_root).load()
    assert store.config is not None
    assert store.config.persona_id == "research-persona"
    assert store.config.revision == 1
    assert {
        (tag.namespace, tag.slug, tag.label)
        for tag in store.of_type(Tag, active_only=True)
    } == {
        ("domain", "ai", "AI"),
        ("domain", "physics", "Physics"),
    }
    assert store.sources == {}
    assert (data_root / "schemas" / "material.v3.schema.json").is_file()
    assert (data_root / "schemas" / "relation.v2.schema.json").is_file()
    assert (data_root / "schemas" / "source-manifest.v2.schema.json").is_file()
    assert (data_root / "schemas" / "preference-context.v1.schema.json").is_file()
    assert (data_root / "schemas" / "preference.v1.schema.json").is_file()
    assert (data_root / "schemas" / "preference-example.v3.schema.json").is_file()
    assert not (data_root / "schemas" / "material.v1.schema.json").exists()
    assert not (data_root / "schemas" / "preference-pack.v1.schema.json").exists()
    assert not (data_root / "schemas" / "preference-rule.v1.schema.json").exists()
    assert not (data_root / "schemas" / "preference-example.v1.schema.json").exists()
    assert not (data_root / "schemas" / "preference-example.v2.schema.json").exists()
    assert (state_root / "persona.sqlite3").is_file()

    snapshot_path = data_root / "generated" / "persona.snapshot.json"
    first_snapshot = snapshot_path.read_bytes()
    snapshot = json.loads(first_snapshot)
    assert snapshot["persona_id"] == "research-persona"
    assert snapshot["knowledge_nodes"] == []
    assert snapshot["materials"] == []
    PersonaCompiler(data_root, state_root).build()
    assert snapshot_path.read_bytes() == first_snapshot

    client = TestClient(create_app(data_root, state_root))
    dashboard = client.get("/")
    assert dashboard.status_code == 200
    assert "<h1>概览</h1>" in dashboard.text
    assert "从一条知识或偏好开始" in dashboard.text
    assert "/knowledge/new" in dashboard.text
    created = client.post(
        "/knowledge/proposals",
        data={
            "title": "量子信息",
            "aliases": "Quantum Information",
            "semantic_role": "domain",
            "knowledge_level": "aware",
            "interest_level": "high",
            "summary": "从空人格库添加的第一个知识领域。",
            "scope_note": "目前了解基本问题。",
            "body": "# 量子信息",
            "reason": "添加第一条知识记录。",
        },
        follow_redirects=False,
    )
    proposal_id = saved_proposal_id(created, data_root)
    assert ProposalRepository(data_root).get(proposal_id).status == "accepted"
    initialized_store = PersonaStore(data_root).load()
    assert len(initialized_store.of_type(KnowledgeNode, active_only=True)) == 1
    assert initialized_store.config is not None
    assert initialized_store.config.revision == 2


def test_init_refuses_to_overwrite_existing_content(tmp_path: Path) -> None:
    data_root = tmp_path / "existing-persona"
    state_root = tmp_path / "fresh-state"
    data_root.mkdir()
    marker = data_root / "keep-me.txt"
    marker.write_text("user data", encoding="utf-8")

    with pytest.raises(InitializationError, match="非空，不会覆盖"):
        initialize_persona(data_root, state_root, persona_id="research-persona")

    assert marker.read_text(encoding="utf-8") == "user data"
    assert not state_root.exists()


def test_workspace_selection_keeps_real_data_separate_from_demo(tmp_path: Path) -> None:
    real_root = tmp_path / "real-persona"
    selected_real = resolve_workspace(
        workspace=real_root,
        data_root=None,
        state_root=None,
        demo=False,
        require_data=True,
        require_state=True,
    )
    selected_demo = resolve_workspace(
        workspace=None,
        data_root=None,
        state_root=None,
        demo=True,
        require_data=True,
        require_state=True,
    )

    assert selected_real.data_root == (real_root / "persona-data").resolve()
    assert selected_real.state_root == (real_root / "persona-state").resolve()
    assert not selected_real.is_demo
    assert selected_demo.data_root != DEMO_DATA_ROOT.resolve()
    assert selected_demo.is_demo
    assert selected_real.data_root != selected_demo.data_root


def test_workspace_selection_never_falls_back_to_demo(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AI_PERSONA_WORKSPACE", raising=False)

    with pytest.raises(ValueError, match="请选择 Persona 工作区"):
        resolve_workspace(
            workspace=None,
            data_root=None,
            state_root=None,
            demo=False,
            require_data=True,
            require_state=True,
        )


def test_cli_can_validate_explicit_demo() -> None:
    assert cli_main(["validate", "--demo"]) == 0


def test_demo_store_validates_and_builds_hierarchy() -> None:
    store = PersonaStore(DEMO_DATA_ROOT).load()

    assert len(store.records) >= 28
    assert len(store.sources) >= 2
    assert (
        "kn_demo_quantum_physics",
        "kn_demo_nonequilibrium",
        2,
    ) in store.relation_closure()
    assert (
        "kn_demo_tensor_network",
        "kn_demo_tebd",
        1,
    ) in store.relation_closure()


def test_build_is_deterministic_with_empty_preferences(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    store = PersonaStore(data_root).load()
    assert store.config is not None
    compiler = PersonaCompiler(data_root, state_root)

    first = compiler.build()
    first_bytes = first.snapshot_path.read_bytes()
    second = PersonaCompiler(data_root, state_root).build()
    second_bytes = second.snapshot_path.read_bytes()

    assert first_bytes == second_bytes
    snapshot = json.loads(second_bytes)
    assert snapshot["schema_version"] == "ai-persona.snapshot/v1"
    assert snapshot["persona_revision"] == store.config.revision
    tebd = next(item for item in snapshot["knowledge_nodes"] if item["title"] == "TEBD")
    assert tebd["semantic_role"] == "technique"
    assert tebd["knowledge_level"] == "proficient"
    assert "schema" in tebd
    assert "schema_id" not in tebd

    assert snapshot["preference_contexts"] == []
    assert snapshot["preferences"] == []
    assert snapshot["preference_examples"] == []
    assert list((data_root / "generated" / "preferences").iterdir()) == []


def test_search_returns_graph_context(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    store = PersonaStore(data_root).load()
    assert store.config is not None
    PersonaCompiler(data_root, state_root).build()

    results = search_index(state_root, "TEBD")

    tebd = next(item for item in results if item["id"] == "kn_demo_tebd")
    assert tebd["semantic_role"] == "technique"
    assert tebd["ancestors"] == [{"id": "kn_demo_tensor_network", "distance": 1}]

    context = prepare_context(
        state_root,
        context_key="note.write",
        question="TEBD",
    )
    assert context["persona_revision"] == store.config.revision
    assert context["preference_context"] is None


def test_broader_than_cycle_is_rejected(tmp_path: Path) -> None:
    data_root, _ = copy_demo(tmp_path)
    cycle_path = data_root / "records" / "relations" / "rel_demo_cycle.md"
    cycle_path.write_text(
        """---
schema: ai-persona.relation/v2
id: rel_demo_cycle
entity_type: relation
source_id: kn_demo_nonequilibrium
relation_type: broader_than
target_id: kn_demo_quantum_physics
evidence_refs: []
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# Invalid cycle
""",
        encoding="utf-8",
    )

    with pytest.raises(StoreValidationError, match="contains a cycle"):
        PersonaStore(data_root).load()


def test_yaml_duplicate_keys_are_rejected() -> None:
    with pytest.raises(FrontmatterError, match="duplicate YAML key"):
        load_yaml_text("id: one\nid: two\n", source="test")


def test_web_demo_renders_dashboard_and_knowledge_detail(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    dashboard = client.get("/")
    detail = client.get("/knowledge/kn_demo_tebd")
    preferences = client.get("/preferences")

    assert dashboard.status_code == 200
    assert "<h1>概览</h1>" in dashboard.text
    assert "暂无待审核内容" in dashboard.text
    assert detail.status_code == 200
    assert "Time-Evolving Block Decimation" in detail.text
    assert preferences.status_code == 200
    assert "当前没有适用的偏好" in preferences.text


def test_web_edit_saves_immediately_with_audit_history(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))
    store = PersonaStore(data_root).load()
    assert store.config is not None
    starting_persona_revision = store.config.revision
    record = store.records["kn_demo_nonequilibrium"].record

    created = client.post(
        f"/knowledge/{record.id}/proposals",
        data={
            "title": record.title,
            "aliases": "\n".join(record.aliases),
            "knowledge_level": record.knowledge_level,
            "interest_level": "medium",
            "summary": record.summary,
            "scope_note": record.scope_note or "",
            "body": store.records[record.id].body,
            "tags": record.tags,
            "reason": "最近的关注重点发生变化。",
        },
        follow_redirects=False,
    )

    assert created.status_code == 303
    proposal_id = saved_proposal_id(created, data_root)
    proposal = ProposalRepository(data_root).get(proposal_id)
    assert proposal.patch[0].field == "interest_level"
    assert proposal.patch[0].before == "high"
    assert proposal.patch[0].after == "medium"

    review = client.get(f"/review/{proposal_id}")
    assert review.status_code == 200
    assert client.get(f"/api/inbox/v1/items/proposal:{proposal_id}/review").json()["proposals"][0]["note"] == "最近的关注重点发生变化。"
    assert 'id="review-edit-form"' not in review.text


    updated_store = PersonaStore(data_root).load()
    updated = updated_store.records[record.id].record
    assert updated.interest_level == "medium"
    assert updated.revision == 2
    assert updated_store.config is not None
    assert updated_store.config.revision == starting_persona_revision + 1
    assert ProposalRepository(data_root).get(proposal_id).status == "accepted"
    snapshot = json.loads((data_root / "generated" / "persona.snapshot.json").read_text())
    assert snapshot["persona_revision"] == starting_persona_revision + 1


def test_web_edit_ignores_browser_line_ending_changes(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))
    store = PersonaStore(data_root).load()
    loaded = store.records["kn_demo_tebd"]
    record = loaded.record

    created = client.post(
        f"/knowledge/{record.id}/proposals",
        data={
            "title": record.title,
            "aliases": "\r\n".join(record.aliases),
            "knowledge_level": record.knowledge_level,
            "interest_level": record.interest_level,
            "summary": record.summary + " 补充说明。",
            "scope_note": record.scope_note or "",
            "body": loaded.body.replace("\n", "\r\n"),
            "tags": [*record.tags, "tag_ai"],
            "reason": "补充知识说明。",
        },
        follow_redirects=False,
    )

    assert created.status_code == 303
    proposal_id = saved_proposal_id(created, data_root)
    proposal = ProposalRepository(data_root).get(proposal_id)
    assert [change.field for change in proposal.patch] == ["summary"]


def test_latest_revision_hash_matches_current_record() -> None:
    store = PersonaStore(DEMO_DATA_ROOT).load()
    lines = (DEMO_DATA_ROOT / "revisions" / "changes.jsonl").read_text(
        encoding="utf-8"
    )
    latest = json.loads(lines.splitlines()[-1])
    change = latest["changes"][0]

    assert change["new_hash"] == record_content_hash(store.records[change["object_id"]])


def test_dedicated_course_and_material_reading_pages(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    dashboard = client.get("/")
    courses = client.get("/courses")
    materials = client.get("/materials")
    course_detail = client.get("/courses/crs_demo_advanced_qm")
    material_detail = client.get("/materials/mat_demo_tebd_note")

    assert 'href="/courses"' in dashboard.text
    assert 'href="/materials"' in dashboard.text
    assert "高等量子力学" in courses.text
    assert "TEBD" not in courses.text
    assert "导入材料" in materials.text
    assert "全部知识角色" in materials.text
    assert "编辑此条目" in course_detail.text
    assert "编辑材料" in material_detail.text
    assert "知识联系" in material_detail.text
    assert "Source Manifest" in material_detail.text

    course = PersonaStore(data_root).load().records["crs_demo_advanced_qm"].record
    assert isinstance(course, Course)
    payload = course.model_dump(mode="json", by_alias=True)
    assert "provider" not in payload
    assert "summary" not in payload
    assert "scope_note" not in payload
    assert "evidence_refs" not in payload
    assert payload["description"] == ""
    assert payload["syllabus"] == ""
    assert "课程简介" in course_detail.text
    assert "课程大纲" in course_detail.text


def test_discipline_tags_are_set_inline_without_review(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    assert client.get("/tags").status_code == 404
    edit_form = client.get("/knowledge/kn_demo_tebd/edit")
    assert edit_form.status_code == 200
    assert "AI" in edit_form.text
    assert "物理学" in edit_form.text
    assert "新增标签" in edit_form.text
    assert "保存标签" in edit_form.text
    assert 'action="/knowledge/kn_demo_tebd/tags"' in edit_form.text

    pending_before = ProposalRepository(data_root).list_pending()
    saved = client.post(
        "/knowledge/kn_demo_tebd/tags",
        data={"tags": ["tag_ai", "tag_physics"], "new_tag": "Mathematics"},
        follow_redirects=False,
    )
    assert saved.status_code == 303
    assert saved.headers["location"].startswith(
        "/knowledge/kn_demo_tebd#tag-settings"
    )
    assert ProposalRepository(data_root).list_pending() == pending_before

    store = PersonaStore(data_root).load()
    mathematics = next(
        tag
        for tag in store.of_type(Tag, active_only=True)
        if tag.slug == "mathematics"
    )
    assert mathematics.namespace == "domain"
    assert {"tag_ai", "tag_physics", mathematics.id} <= set(
        store.records["kn_demo_tebd"].record.tags
    )
    assert "Mathematics" in client.get("/knowledge/kn_demo_tebd").text
    assert "Mathematics" in client.get("/knowledge/new").text
    assert "Mathematics" in client.get("/materials/mat_demo_tebd_note/edit").text

    filtered = client.get(f"/knowledge/table?tag_id={mathematics.id}")
    assert filtered.status_code == 200
    assert "TEBD" in filtered.text
    assert "开放量子系统" not in filtered.text

    reused = client.post(
        "/materials/mat_demo_tebd_note/tags",
        data={"tags": ["tag_physics"], "new_tag": "AI"},
        follow_redirects=False,
    )
    assert reused.status_code == 303
    store = PersonaStore(data_root).load()
    assert set(store.records["mat_demo_tebd_note"].record.tags) == {
        "tag_ai",
        "tag_physics",
    }
    assert len([tag for tag in store.of_type(Tag) if tag.label == "AI"]) == 1


def test_new_record_can_create_an_inline_tag_without_a_tag_review(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    created = client.post(
        "/knowledge/proposals",
        data={
            "title": "Linear Algebra",
            "semantic_role": "area",
            "knowledge_level": "familiar",
            "interest_level": "high",
            "tags": ["tag_ai"],
            "new_tag": "Mathematics",
        },
        follow_redirects=False,
    )
    knowledge_proposal_id = saved_proposal_id(created, data_root)

    store = PersonaStore(data_root).load()
    mathematics = next(tag for tag in store.of_type(Tag) if tag.slug == "mathematics")
    pending = ProposalRepository(data_root).list_pending()
    assert pending == []
    proposal = ProposalRepository(data_root).get(knowledge_proposal_id)
    proposal_values = {change.field: change.after for change in proposal.patch}
    assert proposal_values["tags"] == ["tag_ai", mathematics.id]


def test_web_creates_knowledge_and_course_immediately(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    knowledge_response = client.post(
        "/knowledge/proposals",
        data={
            "title": "Suzuki–Trotter 分解",
            "aliases": "Trotter decomposition",
            "semantic_role": "method",
            "knowledge_level": "familiar",
            "interest_level": "high",
            "summary": "把不对易演化算符分解为可计算的短时步骤。",
            "scope_note": "熟悉二阶分解。",
            "body": "# Suzuki–Trotter 分解",
            "tags": ["tag_physics"],
            "reason": "补充已掌握的方法。",
        },
        follow_redirects=False,
    )
    knowledge_proposal = saved_proposal_id(knowledge_response, data_root)
    proposal = ProposalRepository(data_root).get(knowledge_proposal)
    assert proposal.operation == "create"
    assert proposal.target_entity_type == "knowledge_node"
    assert proposal.target_id in PersonaStore(data_root).load().records
    assert ProposalRepository(data_root).get(knowledge_proposal).status == "accepted"

    course_response = client.post(
        "/courses/proposals",
        data={
            "title": "统计物理",
            "aliases": "Statistical Mechanics",
            "knowledge_level": "familiar",
            "interest_level": "high",
            "description": "介绍统计力学的基本框架与典型模型。",
            "syllabus": "第一章 系综理论\n第二章 相变与临界现象",
            "tags": ["tag_physics"],
            "reason": "补充已经学习过的课程。",
        },
        follow_redirects=False,
    )
    course_proposal = saved_proposal_id(course_response, data_root)
    assert ProposalRepository(data_root).get(course_proposal).status == "accepted"

    store = PersonaStore(data_root).load()
    assert any(
        item.title == "Suzuki–Trotter 分解"
        for item in store.of_type(KnowledgeNode, active_only=True)
    )
    created_course = next(
        item for item in store.of_type(Course, active_only=True) if item.title == "统计物理"
    )
    assert created_course.aliases == ["Statistical Mechanics"]
    assert created_course.description == "介绍统计力学的基本框架与典型模型。"
    assert created_course.syllabus == "第一章 系综理论\n第二章 相变与临界现象"

    course_list = client.get("/courses")
    assert created_course.description in course_list.text
    assert created_course.title in client.get("/courses?q=临界现象").text
    course_detail = client.get(f"/courses/{created_course.id}")
    assert created_course.description in course_detail.text
    assert "第二章 相变与临界现象" in course_detail.text

    search_result = search_index(state_root, "相变与临界现象")[0]
    assert search_result["id"] == created_course.id
    assert search_result["description"] == created_course.description
    assert search_result["syllabus"] == created_course.syllabus
    courses_document = (data_root / "generated/human/courses.md").read_text()
    assert f"Description: {created_course.description}" in courses_document
    assert "第二章 相变与临界现象" in courses_document

    edit_page = client.get(f"/courses/{created_course.id}/edit")
    assert created_course.description in edit_page.text
    assert created_course.syllabus in edit_page.text
    update_response = client.post(
        f"/courses/{created_course.id}/proposals",
        data={
            "title": created_course.title,
            "aliases": "Statistical Mechanics",
            "knowledge_level": "familiar",
            "interest_level": "high",
            "description": "统计物理基础课程。",
            "syllabus": "",
            "tags": ["tag_physics"],
        },
        follow_redirects=False,
    )
    update_proposal = saved_proposal_id(update_response, data_root)
    assert ProposalRepository(data_root).get(update_proposal).status == "accepted"
    updated_course = PersonaStore(data_root).load().records[created_course.id].record
    assert updated_course.description == "统计物理基础课程。"
    assert updated_course.syllabus == ""


def test_relation_add_remove_and_cycle_check(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    response = client.post(
        "/knowledge/kn_demo_tebd/relation-proposals",
        data={
            "relation_type": "requires",
            "target_id": "kn_demo_quantum_physics",
            "reason": "补充 TEBD 的理论前置知识。",
        },
        follow_redirects=False,
    )
    proposal_id = saved_proposal_id(response, data_root)
    assert ProposalRepository(data_root).get(proposal_id).operation == "relate"
    assert ProposalRepository(data_root).get(proposal_id).status == "accepted"

    store = PersonaStore(data_root).load()
    relation = next(
        item
        for item in store.of_type(Relation, active_only=True)
        if item.source_id == "kn_demo_tebd"
        and item.relation_type == "requires"
        and item.target_id == "kn_demo_quantum_physics"
    )
    remove = client.post(
        f"/relations/{relation.id}/remove-proposals",
        data={"reason": "移除测试关系。"},
        follow_redirects=False,
    )
    remove_id = saved_proposal_id(remove, data_root)
    assert ProposalRepository(data_root).get(remove_id).operation == "unrelate"
    assert ProposalRepository(data_root).get(remove_id).status == "accepted"
    assert PersonaStore(data_root).load().records[relation.id].record.status == "archived"

    cycle = client.post(
        "/knowledge/kn_demo_nonequilibrium/relation-proposals",
        data={
            "relation_type": "broader_than",
            "target_id": "kn_demo_quantum_physics",
            "reason": "这条关系会形成环。",
        },
        follow_redirects=False,
    )
    assert cycle.headers["location"].startswith("/knowledge/kn_demo_nonequilibrium?")
    assert "kind=error" in cycle.headers["location"]


def test_web_adds_multiple_knowledge_relations_atomically(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))
    repository = ProposalRepository(data_root)

    detail = client.get("/knowledge/kn_demo_nonequilibrium")
    assert "添加另一条关系" in detail.text
    assert "data-relation-row-template" in detail.text
    assert "输入名称、别名或关键词" in detail.text
    assert 'class="button ghost small relation-row-add"' in detail.text
    assert 'select name="target_id"' not in detail.text

    before_ids = {proposal.id for proposal in repository.list_history(limit=1000)}
    response = client.post(
        "/knowledge/kn_demo_nonequilibrium/relation-proposals",
        data={
            "relation_type": ["requires", "requires"],
            "target_id": ["kn_demo_mps", "kn_demo_tebd"],
            "reason": "一次补充两个依赖关系。",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert not response.headers["location"].startswith("/review")
    assert repository.list_pending() == []
    proposals = [
        proposal
        for proposal in repository.list_history(limit=1000)
        if proposal.id not in before_ids
    ]
    assert len(proposals) == 2
    for proposal in proposals:
        assert proposal.operation == "relate"
        assert proposal.reason == "一次补充两个依赖关系。"
        assert ProposalRepository(data_root).get(proposal.id).status == "accepted"

    relations = PersonaStore(data_root).load().of_type(Relation, active_only=True)
    added_targets = {
        relation.target_id
        for relation in relations
        if relation.source_id == "kn_demo_nonequilibrium"
        and relation.relation_type == "requires"
    }
    assert {"kn_demo_mps", "kn_demo_tebd"} <= added_targets

    before_invalid = {proposal.id for proposal in repository.list_pending()}
    invalid = client.post(
        "/knowledge/kn_demo_mps/relation-proposals",
        data={
            "relation_type": ["requires", "related_to"],
            "target_id": ["kn_demo_nonequilibrium", "kn_demo_mps"],
        },
        follow_redirects=False,
    )
    assert "kind=error" in invalid.headers["location"]
    assert {proposal.id for proposal in repository.list_pending()} == before_invalid


def test_web_adds_multiple_material_knowledge_connections(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))
    repository = ProposalRepository(data_root)
    material_id = "mat_demo_tebd_note"

    detail = client.get(f"/materials/{material_id}")
    assert "添加另一条关系" in detail.text
    assert "每一行是一条独立联系" in detail.text
    assert "data-knowledge-combobox" in detail.text
    assert 'select name="target_id"' not in detail.text

    before_ids = {proposal.id for proposal in repository.list_history(limit=1000)}
    response = client.post(
        f"/materials/{material_id}/relation-proposals",
        data={
            "target_id": ["kn_demo_mps", "kn_demo_quantum_physics"],
            "knowledge_role": ["method", "background"],
            "salience": ["primary", "secondary"],
            "statement": [
                "这份笔记以矩阵乘积态表示量子多体波函数。",
                "量子物理是理解笔记中动力学问题的理论背景。",
            ],
            "reason": "一次补充材料中的两个知识联系。",
        },
        follow_redirects=False,
    )
    assert response.status_code == 303
    assert not response.headers["location"].startswith("/review")
    assert repository.list_pending() == []
    proposals = [
        proposal
        for proposal in repository.list_history(limit=1000)
        if proposal.id not in before_ids
    ]
    assert len(proposals) == 2
    for proposal in proposals:
        assert ProposalRepository(data_root).get(proposal.id).status == "accepted"

    relations = PersonaStore(data_root).load().of_type(Relation, active_only=True)
    added = {
        (relation.target_id, relation.knowledge_role, relation.salience)
        for relation in relations
        if relation.source_id == material_id
    }
    assert ("kn_demo_mps", "method", "primary") in added
    assert ("kn_demo_quantum_physics", "background", "secondary") in added


def test_knowledge_suggestions_search_alias_path_and_existing_relations(
    tmp_path: Path,
) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    alias_match = client.get(
        "/api/knowledge/suggestions",
        params={
            "q": "Matrix Product",
            "source_id": "kn_demo_tebd",
            "relation_type": "requires",
        },
    )
    assert alias_match.status_code == 200
    assert alias_match.json()[0] == {
        "id": "kn_demo_mps",
        "title": "矩阵乘积态",
        "aliases": ["Matrix Product State", "MPS"],
        "role": "模型",
        "path": ["张量网络方法"],
        "disabled": True,
    }

    path_match = client.get(
        "/api/knowledge/suggestions",
        params={"q": "张量网络", "source_id": "kn_demo_quantum_physics"},
    )
    assert {item["id"] for item in path_match.json()} >= {
        "kn_demo_tensor_network",
        "kn_demo_mps",
    }

    recent = client.get(
        "/api/knowledge/suggestions",
        params={"source_id": "kn_demo_tebd"},
    ).json()
    assert len(recent) <= 10
    assert all(item["id"] != "kn_demo_tebd" for item in recent)

    material_match = client.get(
        "/api/knowledge/suggestions",
        params={
            "q": "TEBD",
            "source_id": "mat_demo_tebd_note",
            "relation_type": "covers",
            "knowledge_role": "method",
        },
    ).json()
    assert material_match[0]["id"] == "kn_demo_tebd"
    assert material_match[0]["disabled"] is True


def test_archive_cascades_relations_but_increments_persona_once(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))
    store = PersonaStore(data_root).load()
    assert store.config is not None
    start_revision = store.config.revision
    related_ids = {
        relation.id
        for relation in store.of_type(Relation, active_only=True)
        if "kn_demo_tensor_network" in {relation.source_id, relation.target_id}
    }

    response = client.post(
        "/knowledge/kn_demo_tensor_network/archive-proposals",
        data={"reason": "暂时归档这一知识方向。"},
        follow_redirects=False,
    )
    proposal_id = saved_proposal_id(response, data_root)
    review = client.get(f"/review/{proposal_id}")
    assert 'id="review-edit-form"' not in review.text
    assert ProposalRepository(data_root).get(proposal_id).status == "accepted"

    updated = PersonaStore(data_root).load()
    assert updated.config is not None
    assert updated.config.revision == start_revision + 1
    assert updated.records["kn_demo_tensor_network"].record.status == "archived"
    assert related_ids
    assert all(updated.records[item].record.status == "archived" for item in related_ids)


def test_manual_preference_context_and_example_maintenance(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    context_response = client.post(
        "/preferences/contexts/proposals",
        data={
            "name": "研究 Note 写作",
            "key": "note.write",
            "description": "整理研究笔记和推导过程。",
            "intents": "写研究笔记",
        },
        follow_redirects=False,
    )
    context_proposal = saved_proposal_id(context_response, data_root)
    assert ProposalRepository(data_root).get(context_proposal).status == "accepted"
    store = PersonaStore(data_root).load()
    preference_context = next(
        item
        for item in store.of_type(PreferenceContext, active_only=True)
        if item.key == "note.write"
    )
    sample_form = client.get(
        f"/preferences/examples/new?context_id={preference_context.id}"
    )
    assert sample_form.status_code == 200
    assert 'enctype="multipart/form-data"' in sample_form.text
    assert 'name="sample_file"' in sample_form.text
    assert (
        f'name="context_refs" value="{preference_context.id}" checked'
        in sample_form.text
    )
    assert 'name="preference_refs"' not in sample_form.text

    preference_response = client.post(
        "/preferences/proposals",
        data={
            "scope": "contexts",
            "context_refs": [preference_context.id],
            "behavior": "preferred",
            "instruction": "先给出推导路线，再展开计算。",
            "condition": "Note 包含多步推导时",
            "rationale": "便于以后快速恢复思路。",
        },
        follow_redirects=False,
    )
    preference_proposal = saved_proposal_id(preference_response, data_root)
    assert ProposalRepository(data_root).get(preference_proposal).status == "accepted"
    preference = PersonaStore(data_root).load().records[
        ProposalRepository(data_root).get(preference_proposal).target_id
    ].record
    assert isinstance(preference, Preference)

    example_response = client.post(
        "/preferences/examples/proposals",
        data={
            "example_type": "positive",
            "title": "先展示推导路线的 Note",
            "condition": "多步推导",
            "reasons": "读者可以先建立整体结构。",
            "context_refs": [preference_context.id],
        },
        files={
            "sample_file": (
                "reasoning-path-note.md",
                b"First show the three steps, then work through each one.\n",
                "text/markdown",
            )
        },
        follow_redirects=False,
    )
    example_proposal = saved_proposal_id(example_response, data_root)
    example_review = client.get(f"/review/{example_proposal}")
    assert example_review.status_code == 200
    assert client.get(f"/api/inbox/v1/items/proposal:{example_proposal}/review").json()["proposals"][0]["title"] == "先展示推导路线的 Note"
    assert 'id="review-edit-form"' not in example_review.text
    assert ProposalRepository(data_root).get(example_proposal).status == "accepted"

    updated = PersonaStore(data_root).load()
    example = next(
        item
        for item in updated.of_type(PreferenceExample, active_only=True)
        if item.title == "先展示推导路线的 Note"
    )
    assert example.context_refs == [preference_context.id]
    assert updated.records[example.id].body == ""
    assert example.source_ref in updated.sources
    source = updated.sources[example.source_ref]
    assert source.origin.identifier == "reasoning-path-note.md"
    assert (
        data_root / "sources" / example.source_ref / source.canonical_file
    ).read_bytes() == b"First show the three steps, then work through each one.\n"
    compiled = (data_root / "generated" / "preferences" / "note.write.md").read_text(
        encoding="utf-8"
    )
    assert "先展示推导路线的 Note" in compiled
    assert "reasoning-path-note.md" in compiled
    runtime = prepare_context(
        state_root, context_key="note.write", question="TEBD"
    )["preference_context"]
    assert runtime is not None
    assert runtime["matched_contexts"][0]["name"] == "研究 Note 写作"
    assert runtime["preferences"][0]["id"] == preference.id
    assert runtime["selected_examples"][0]["id"] == example.id
    preference_page = client.get("/preferences")
    assert "reasoning-path-note.md" in preference_page.text
    assert f"/preferences/examples/{example.id}/file" in preference_page.text

    pause_response = client.post(
        f"/preferences/preferences/{preference.id}/state-proposals",
        data={"status": "paused"},
        follow_redirects=False,
    )
    pause_proposal = saved_proposal_id(pause_response, data_root)
    assert ProposalRepository(data_root).get(pause_proposal).status == "accepted"
    assert PersonaStore(data_root).load().records[preference.id].record.status == "paused"
    paused_runtime = prepare_context(
        state_root, context_key="note.write", question="TEBD"
    )["preference_context"]
    assert paused_runtime is not None
    assert paused_runtime["preferences"] == []
    assert paused_runtime["selected_examples"][0]["id"] == example.id
    assert paused_runtime["selected_examples"][0]["filename"] == "reasoning-path-note.md"

    resume_response = client.post(
        f"/preferences/preferences/{preference.id}/state-proposals",
        data={"status": "active"},
        follow_redirects=False,
    )
    resume_proposal = saved_proposal_id(resume_response, data_root)
    assert ProposalRepository(data_root).get(resume_proposal).status == "accepted"

    archive_response = client.post(
        f"/preferences/preferences/{preference.id}/archive-proposals",
        follow_redirects=False,
    )
    archive_proposal = saved_proposal_id(archive_response, data_root)
    assert ProposalRepository(data_root).get(archive_proposal).status == "accepted"
    assert PersonaStore(data_root).load().records[preference.id].record.status == "archived"


def test_material_v3_preserves_v2_but_rejects_v1(tmp_path: Path) -> None:
    assert not (DEMO_DATA_ROOT / "schemas" / "material.v1.schema.json").exists()
    assert not (DEMO_DATA_ROOT / "schemas" / "relation.v1.schema.json").exists()
    assert not (
        DEMO_DATA_ROOT / "schemas" / "source-manifest.v1.schema.json"
    ).exists()

    data_root, _ = copy_demo(tmp_path)
    material_path = data_root / "records" / "materials" / "mat_demo_tebd_note.md"
    material_path.write_text(
        material_path.read_text(encoding="utf-8").replace(
            "ai-persona.material/v2", "ai-persona.material/v1", 1
        ),
        encoding="utf-8",
    )
    with pytest.raises(StoreValidationError, match="ai-persona.material/v3"):
        PersonaStore(data_root).load()


def test_evidence_line_locator_must_point_inside_saved_source(tmp_path: Path) -> None:
    data_root, _ = copy_demo(tmp_path)
    evidence_path = data_root / "records" / "evidence" / "ev_demo_note.md"
    evidence_path.write_text(
        evidence_path.read_text(encoding="utf-8").replace("line_end: 9", "line_end: 99"),
        encoding="utf-8",
    )
    with pytest.raises(StoreValidationError, match="line range exceeds"):
        PersonaStore(data_root).load()


def test_material_create_edit_relation_source_archive_and_restore(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))
    starting_sources = len(PersonaStore(data_root).load().sources)

    created = client.post(
        "/materials/proposals",
        data=material_form_data(),
        follow_redirects=False,
    )
    assert created.status_code == 303
    create_proposal_id = saved_proposal_id(created, data_root)
    proposal = ProposalRepository(data_root).get(create_proposal_id)
    assert proposal.operation == "create"
    assert proposal.target_entity_type == "material"
    source_id = next(item.after for item in proposal.patch if item.field == "source_ref")
    assert not (data_root / "sources" / ".staging" / source_id).exists()
    assert (data_root / "sources" / source_id / "manifest.yaml").is_file()

    review = client.get(f"/review/{create_proposal_id}")
    assert review.status_code == 200
    assert 'id="review-edit-form"' not in review.text

    material_id = proposal.target_id
    store = PersonaStore(data_root).load()
    material = store.records[material_id].record
    assert isinstance(material, Material)
    assert material.schema_id == "ai-persona.material/v3"
    assert material.user_relationships == ["read"]
    assert material.preference_level == "liked"
    assert source_id in store.sources
    assert not (data_root / "sources" / ".staging" / source_id).exists()
    assert len(store.sources) == starting_sources + 1
    assert search_index(state_root, "quench-front-velocity")[0]["id"] == material_id

    source_response = client.get(f"/materials/{material_id}/source")
    manifest_response = client.get(f"/materials/{material_id}/source-manifest")
    assert source_response.status_code == 200
    assert b"quench-front-velocity" in source_response.content
    assert manifest_response.status_code == 200
    assert "ai-persona.source-manifest/v2" in manifest_response.text

    source_text_response = client.get(f"/materials/{material_id}/source-text")
    assert source_text_response.status_code == 200
    assert "将原文片段保存为依据" in source_text_response.text
    evidence_response = client.post(
        f"/materials/{material_id}/evidence-proposals",
        data={
            "line_start": "1",
            "line_end": "3",
            "heading": "New source",
            "reason": "保存用于解释材料关系的原文片段。",
        },
        follow_redirects=False,
    )
    evidence_proposal_id = saved_proposal_id(evidence_response, data_root)
    evidence_proposal = ProposalRepository(data_root).get(evidence_proposal_id)
    assert evidence_proposal.target_entity_type == "evidence"
    assert ProposalRepository(data_root).get(evidence_proposal_id).status == "accepted"
    evidence_id = evidence_proposal.target_id
    evidence = PersonaStore(data_root).load().records[evidence_id].record
    assert isinstance(evidence, Evidence)
    assert evidence.supports == [material_id]
    assert evidence.locator["line_start"] == 1
    assert evidence.source_hash.startswith("sha256:")

    relation_response = client.post(
        f"/materials/{material_id}/relation-proposals",
        data={
            "target_id": "kn_demo_tebd",
            "knowledge_role": "method",
            "salience": "primary",
            "statement": "这份 Note 用 TEBD 分析量子深混后传播前沿的实时演化。",
            "evidence_refs": [evidence_id],
            "reason": "记录材料使用的核心方法。",
        },
        follow_redirects=False,
    )
    relation_proposal_id = saved_proposal_id(relation_response, data_root)
    assert ProposalRepository(data_root).get(relation_proposal_id).status == "accepted"
    store = PersonaStore(data_root).load()
    relation = next(
        item
        for item in store.of_type(Relation, active_only=True)
        if item.source_id == material_id and item.target_id == "kn_demo_tebd"
    )
    assert relation.knowledge_role == "method"
    assert relation.salience == "primary"
    assert relation.evidence_refs == [evidence_id]
    relation_detail = client.get(f"/materials/{material_id}")
    assert f"/materials/{material_id}/source-text#L1" in relation_detail.text

    filtered = client.get(
        "/materials/table?knowledge_id=kn_demo_tensor_network"
        "&knowledge_role=method&salience=primary"
    )
    excluded = client.get(
        "/materials/table?knowledge_role=method&salience=secondary"
    )
    assert "Quench front reading note" in filtered.text
    assert "Quench front reading note" not in excluded.text

    updated = client.post(
        f"/materials/{material_id}/proposals",
        data=material_form_data(
            source_mode=None,
            source_text=None,
            preference_level="favorite",
            summary="已确认这是一份特别重要的深混传播 Note。",
            reason="阅读后提升对材料的喜欢程度。",
        ),
        follow_redirects=False,
    )
    update_proposal_id = saved_proposal_id(updated, data_root)
    assert ProposalRepository(data_root).get(update_proposal_id).status == "accepted"
    material = PersonaStore(data_root).load().records[material_id].record
    assert isinstance(material, Material)
    assert material.preference_level == "favorite"
    assert material.revision == 2

    source_update = client.post(
        f"/materials/{material_id}/source-proposals",
        data={
            "source_mode": "paste",
            "source_text": "# Revised immutable source\n\nA corrected derivation.",
            "material_type": "note",
            "reason": "保存修正后的原文版本。",
        },
        follow_redirects=False,
    )
    source_proposal_id = saved_proposal_id(source_update, data_root)
    assert ProposalRepository(data_root).get(source_proposal_id).status == "accepted"
    store = PersonaStore(data_root).load()
    revised = store.records[material_id].record
    assert isinstance(revised, Material)
    assert revised.source_ref != source_id
    assert source_id in store.sources
    assert revised.revision == 3

    archived = client.post(
        f"/materials/{material_id}/archive-proposals",
        data={"reason": "测试材料归档。"},
        follow_redirects=False,
    )
    archive_proposal_id = saved_proposal_id(archived, data_root)
    assert ProposalRepository(data_root).get(archive_proposal_id).status == "accepted"
    store = PersonaStore(data_root).load()
    assert store.records[material_id].record.status == "archived"
    assert store.records[relation.id].record.status == "archived"

    restored = client.post(
        f"/materials/{material_id}/restore-proposals",
        data={"reason": "重新恢复这份材料。"},
        follow_redirects=False,
    )
    restore_proposal_id = saved_proposal_id(restored, data_root)
    assert ProposalRepository(data_root).get(restore_proposal_id).status == "accepted"
    store = PersonaStore(data_root).load()
    assert store.records[material_id].record.status == "active"
    assert store.records[relation.id].record.status == "archived"


def test_material_duplicate_source_and_weak_relation_are_rejected(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))
    original = (data_root / "sources" / "src_demo_note" / "original.md").read_text(
        encoding="utf-8"
    )
    duplicate = client.post(
        "/materials/proposals",
        data=material_form_data(
            source_text=original,
            title="A duplicate source record",
            arxiv="2609.54321",
        ),
        follow_redirects=False,
    )
    assert duplicate.status_code == 303
    assert duplicate.headers["location"].startswith("/materials/new?")
    assert "kind=error" in duplicate.headers["location"]
    staging_root = data_root / "sources" / ".staging"
    assert not staging_root.exists() or not list(staging_root.iterdir())

    weak_relation = client.post(
        "/materials/mat_demo_tebd_note/relation-proposals",
        data={
            "target_id": "kn_demo_tebd",
            "knowledge_role": "result",
            "salience": "secondary",
            "statement": "TEBD",
            "reason": "这个说明不够具体。",
        },
        follow_redirects=False,
    )
    assert weak_relation.status_code == 303
    assert weak_relation.headers["location"].startswith(
        "/materials/mat_demo_tebd_note?"
    )
    assert "kind=error" in weak_relation.headers["location"]


def test_material_human_projection_contains_connections_and_source(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    PersonaCompiler(data_root, state_root).build()
    overview = (data_root / "generated" / "human" / "materials.md").read_text(
        encoding="utf-8"
    )
    detail = (
        data_root
        / "generated"
        / "human"
        / "materials"
        / "mat_demo_tebd_note.md"
    ).read_text(encoding="utf-8")

    assert "topics=非平衡量子动力学" in overview
    assert "methods=TEBD" in overview
    assert "## Source" in detail
    assert "sources/src_demo_note/original.md" in detail
    assert "Evidence `ev_demo_note`" in detail


def test_material_file_upload_and_url_staging(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))
    upload = client.post(
        "/materials/proposals",
        data=material_form_data(
            source_mode="upload",
            source_text="",
            title="Uploaded source material",
            arxiv="2609.33333",
        ),
        files={
            "source_file": (
                "uploaded.txt",
                b"A source supplied through the upload control.",
                "text/plain",
            )
        },
        follow_redirects=False,
    )
    assert upload.status_code == 303
    proposal = ProposalRepository(data_root).get(saved_proposal_id(upload, data_root))
    source_id = next(item.after for item in proposal.patch if item.field == "source_ref")
    manifest = (
        data_root / "sources" / source_id / "manifest.yaml"
    ).read_text(encoding="utf-8")
    assert "original.txt" in manifest
    assert "extracted.md" in manifest

    class FakeHeaders:
        @staticmethod
        def get_content_type() -> str:
            return "text/html"

    class FakeResponse:
        headers = FakeHeaders()

        def __enter__(self) -> FakeResponse:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        @staticmethod
        def read(_: int) -> bytes:
            return b"<html><body><h1>Paper</h1><p>Downloaded source body.</p></body></html>"

        @staticmethod
        def geturl() -> str:
            return "https://papers.example/final.html"

    monkeypatch.setattr(
        "ai_persona.materials.urllib.request.urlopen",
        lambda *_args, **_kwargs: FakeResponse(),
    )
    staged = stage_url_source(
        data_root,
        url="https://papers.example/start",
        source_type="article",
        identifier="example-1",
    )
    assert staged.manifest.schema_id == "ai-persona.source-manifest/v2"
    assert staged.manifest.origin.url == "https://papers.example/final.html"
    assert (staged.path / "original.html").is_file()
    assert "Downloaded source body" in (staged.path / "extracted.md").read_text(
        encoding="utf-8"
    )


def test_ui_language_switch_persists_without_translating_user_content(
    tmp_path: Path,
) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    switched = client.post(
        "/language",
        data={"locale": "en", "return_to": "/materials?status=active"},
        follow_redirects=False,
    )

    assert switched.status_code == 303
    assert switched.headers["location"] == "/materials?status=active"
    assert "ai_persona_locale=en" in switched.headers["set-cookie"]

    dashboard = client.get("/")
    knowledge = client.get("/knowledge")
    courses = client.get("/courses")
    materials = client.get("/materials")
    preferences = client.get("/preferences")
    review = client.get("/review")
    material_detail = client.get("/materials/mat_demo_tebd_note")
    partial = client.get("/materials/table")

    assert '<html lang="en">' in dashboard.text
    assert "My Persona" in dashboard.text and "Confirmed content" in dashboard.text
    assert "<h1>Knowledge Library</h1>" in knowledge.text
    assert "<h1>Course Library</h1>" in courses.text
    assert "<h1>Material Library</h1>" in materials.text
    assert "<h1>My Preferences</h1>" in preferences.text
    assert 'id="inbox-root"' in review.text and review.url.path == "/inbox"
    assert '<p class="eyebrow duplicate-in-english">KNOWLEDGE LIBRARY</p>' in knowledge.text
    assert "用 TEBD 理解一维量子系统的实时演化" in material_detail.text
    assert "Source saved" in partial.text
    assert "REVISION" in dashboard.text.upper()

    chinese = client.post(
        "/language",
        data={"locale": "zh-CN", "return_to": "/courses"},
        follow_redirects=True,
    )
    assert '<html lang="zh-CN">' in chinese.text
    assert "掌握的课程" in chinese.text


def test_language_switch_rejects_external_return_path(tmp_path: Path) -> None:
    data_root, state_root = copy_demo(tmp_path)
    client = TestClient(create_app(data_root, state_root))

    response = client.post(
        "/language",
        data={"locale": "en", "return_to": "https://example.com"},
        follow_redirects=False,
    )

    assert response.status_code == 303
    assert response.headers["location"] == "/"
    validate_catalogs()
