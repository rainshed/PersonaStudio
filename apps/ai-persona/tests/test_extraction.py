from __future__ import annotations

import shutil

import pytest
from fastapi.testclient import TestClient
from persona_fixture import demo_workspace

from ai_persona.agent import AgentServiceError
from ai_persona.compiler import PersonaCompiler
from ai_persona.extraction.service import ExtractionService
from ai_persona.extraction.sources import parse_html
from ai_persona.material_imports.arxiv import normalize_arxiv_input
from ai_persona.models import Material
from ai_persona.proposals import ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_PERSONA_SEMANTIC_SEARCH", "0")
    data, state = tmp_path / "data", tmp_path / "state"
    shutil.copytree(demo_workspace().data_root, data)
    PersonaCompiler(data, state).build()
    return ExtractionService(data, state)


def add(
    service,
    task=None,
    text="# Example paper\n\nSpectral clustering partitions a similarity graph using its eigenvectors.\n",
    name="paper.md",
):
    task = task or service.repository.create()
    return service.add(task["id"], task["revision"], filename=name, content=text.encode())


def phase(service, task, sid):
    run = service.start(task["id"], task["revision"])
    with service.repository.edit(task["id"], run_id=run) as current:
        current["phase"] = sid
    return run


def candidate(ref, basis, entity="knowledge_node", values=None, operation="create"):
    return dict(
        client_ref=ref,
        operation=operation,
        entity_type=entity,
        reason="The source explicitly defines this concept.",
        values=values
        or {
            "title": "Spectral clustering",
            "semantic_role": "method",
            "summary": "Partitions a similarity graph using its eigenvectors.",
        },
        basis=[{"ref": basis}],
    )


class FixtureBackend:
    def __init__(self, fail=None):
        self.calls = []
        self.fail = fail

    def cancel(self, task_id):
        pass

    def start(self, service, task_id, run_id, source):
        self.calls.append(source)

        def call(**args):
            return service.tool(task_id, run_id, args)

        if source == self.fail:
            raise AgentServiceError("fixture_failure", "模拟该材料未完成")
        if source not in {"merge", "autonomous"}:
            read = call(action="read", source_id=source)
            call(
                action="checkpoint",
                source_id=source,
                analysis={
                    "summary": "Found a graph partitioning method.",
                    "changes": [candidate("shared", read["basis_ref"])],
                },
            )
            return
        sources = call(action="overview")["sources"]
        if self.fail and any(m["origin"] == self.fail for m in sources):
            for m in sources:
                if m["origin"] == self.fail:
                    continue
                read = call(action="read", source_id=m["origin"])
                call(
                    action="checkpoint",
                    source_id=m["origin"],
                    analysis={
                        "summary": "Saved independent source findings",
                        "changes": [candidate("shared", read["basis_ref"])],
                    },
                )
            raise AgentServiceError("fixture_failure", "模拟该材料未完成")
        changes, refs = [], []
        for i, m in enumerate(sources):
            read = call(action="read", source_id=m["origin"])
            refs.append({"ref": read["basis_ref"]})
            changes.append(
                candidate(
                    "paper" + str(i),
                    read["basis_ref"],
                    "material",
                    {"title": m["title"], "source_ref": m["origin"], "material_type": "paper"},
                )
            )
            changes.append(
                candidate(
                    "link" + str(i),
                    read["basis_ref"],
                    "relation",
                    {
                        "source_ref": "paper" + str(i),
                        "target_ref": "shared",
                        "relation_type": "covers",
                        "knowledge_role": "method",
                        "salience": "primary",
                        "statement": "The paper uses spectral clustering.",
                    },
                    "relate",
                )
            )
        kn = candidate("shared", refs[0]["ref"])
        kn["basis"] = refs
        self.draft = {
            "kind": "propose",
            "summary": "One shared concept supported by the included papers.",
            "changes": [kn, *changes],
        }
        call(action="submit", draft=self.draft)


def test_bounded_structured_read_and_immutable_provenance(service):
    task = add(service, text="# Title\n\n" + "long paragraph " * 3000)
    sid = task["members"][0]["source_id"]
    run = phase(service, task, sid)
    overview = service.tool(task["id"], run, {"action": "overview", "source_id": sid})
    assert "text" not in overview
    read = service.tool(task["id"], run, {"action": "read", "source_id": sid, "count": 200})
    assert len(read["text"]) < 18500 and read["next_start"]
    ledger = service.repository.get(task["id"])["ledger"]
    assert ledger["basis"][read["basis_ref"]]["source_hash"].startswith("sha256:")
    assert ledger["coverage"][sid] == [[read["start"], read["end"]]]
    with pytest.raises(AgentServiceError, match="范围"):
        service.tool(task["id"], run, {"action": "read", "source_id": "src_other"})


def test_html_structure_math_and_removed_page_chrome():
    content = b'<html><nav>Ignore</nav><article><h1>Paper</h1><section id="S1"><h2>Method</h2><p>A <math alttext="x^2"><annotation encoding="application/x-tex">duplicate</annotation></math> term.</p><script>bad()</script><table><tr><td>Result</td></tr></table></section></article></html>'
    parsed, _ = parse_html(content)
    assert "$x^2$" in parsed["text"] and "duplicate" not in parsed["text"]
    assert "Ignore" not in parsed["text"] and "bad()" not in parsed["text"]
    assert parsed["sections"][1]["anchor"] == "S1"
    assert normalize_arxiv_input("https://arxiv.org/html/2310.03069v2").requested_version == "v2"


def test_duplicate_remove_and_independent_progress(service):
    task = add(service)
    task = add(service, task)
    assert task["members"][1]["duplicate_of"] == task["members"][0]["id"]
    assert len(service.store().sources) == len({m["source_id"] for m in task["members"]}) + len(
        PersonaStore(demo_workspace().data_root).load().sources
    )
    task = service.modify(task["id"], task["revision"], remove=task["members"][0]["id"])
    assert not task["members"][1].get("duplicate_of")


def test_batch_merge_review_dependencies_idempotency_and_material_v3(service):
    task = add(service)
    task = add(
        service,
        task,
        text="# Another paper\nWe apply spectral clustering to partition a similarity graph.\n",
    )
    before = service.store().config.revision
    backend = FixtureBackend()
    service.backend = backend
    run = service.start(task["id"], task["revision"])
    service.run(task["id"], run)
    result = service.view(task["id"])
    assert result["status"] == "review", result.get("error")
    assert backend.calls == ["autonomous"]
    group = result["submissions"][0]
    assert len(group["proposals"]) == 5
    assert service.store().config.revision == before
    assert len(result["graph"]["nodes"]) == 3 and len(result["graph"]["edges"]) == 2
    assert len(result["evidence"]) == 2
    assert any(p["dependencies"] for p in group["proposals"] if p["entity_type"] == "relation")
    # Retried delivery after a crash retrieves exactly the same committed proposal group.
    with service.repository.edit(task["id"]) as t:
        t.update(status="running", run_id="replay", phase="merge")
    repeated = service.tool(task["id"], "replay", {"action": "submit", "draft": backend.draft})
    assert repeated["submissions"][0]["change_set_id"] == group["change_set_id"]
    proposals = ProposalService(service.data_root, service.state_root)
    for p in sorted(group["proposals"], key=lambda p: p["entity_type"] == "relation"):
        proposals.accept(p["proposal_id"])
    material = next(m for m in service.store().of_type(Material) if m.title == "Example paper")
    assert material.schema_id == "ai-persona.material/v3" and material.user_relationships == []
    assert all(
        n["detail"]["status"] == "accepted" for n in service.view(task["id"])["graph"]["nodes"]
    )


def test_no_change_preview_includes_previously_reviewed_graph(service):
    task = add(service)
    service.backend = FixtureBackend()
    run = service.start(task["id"], task["revision"])
    service.run(task["id"], run)
    group = service.view(task["id"])["submissions"][0]
    reviews = ProposalService(service.data_root, service.state_root)
    for proposal in sorted(group["proposals"], key=lambda p: p["entity_type"] == "relation"):
        reviews.accept(proposal["proposal_id"])
    with service.repository.edit(task["id"]) as current:
        current.update(
            submissions=[],
            submission_intent=False,
            draft={"kind": "no_change", "summary": "Already represented", "changes": []},
        )
    graph = service.view(task["id"])["graph"]
    assert len(graph["nodes"]) == 2 and len(graph["edges"]) == 1
    assert all(n["detail"]["status"] == "existing" for n in graph["nodes"])


def test_partial_failure_cancel_stale_run_and_resume(service):
    task = add(service)
    task = add(service, task, text="# Second\nA second source about graph clustering.\n")
    failed_sid = task["members"][1]["source_id"]
    service.backend = FixtureBackend(fail=failed_sid)
    run = service.start(task["id"], task["revision"])
    service.run(task["id"], run)
    result = service.view(task["id"])
    assert result["status"] == "paused" and not result["submissions"]
    assert result["members"][0]["status"] == "complete"
    assert result["members"][1]["status"] == "ready"
    run2 = service.start(task["id"], result["revision"], partial=True)
    with pytest.raises(AgentServiceError, match="停止"):
        service.tool(task["id"], run, {"action": "overview"})
    service.run(task["id"], run2)
    result = service.view(task["id"])
    assert result["status"] == "review" and result["result_sources"] == [
        task["members"][0]["source_id"]
    ]


def test_personal_and_unread_evidence_rejected_and_no_direct_write(service):
    task = add(service)
    sid = task["members"][0]["source_id"]
    run = phase(service, task, sid)
    service.tool(task["id"], run, {"action": "read", "source_id": sid})
    bad = candidate("a", "invented")
    with pytest.raises(AgentServiceError, match="依据"):
        service.tool(
            task["id"],
            run,
            {
                "action": "checkpoint",
                "source_id": sid,
                "analysis": {"summary": "test", "changes": [bad]},
            },
        )
    basis = service.tool(task["id"], run, {"action": "read", "source_id": sid})["basis_ref"]
    bad["basis"] = [{"ref": basis}]
    bad["values"]["knowledge_level"] = "proficient"
    with pytest.raises(AgentServiceError, match="个人"):
        service.tool(
            task["id"],
            run,
            {
                "action": "checkpoint",
                "source_id": sid,
                "analysis": {"summary": "test", "changes": [bad]},
            },
        )
    service.cancel(task["id"])
    with pytest.raises(AgentServiceError, match="停止"):
        service.tool(
            task["id"],
            run,
            {"action": "checkpoint", "source_id": sid, "analysis": {"summary": "late"}},
        )


def test_http_csrf_page_defaults_and_original_download(service):
    app = create_app(service.data_root, service.state_root)
    with TestClient(app) as client:
        assert client.get("/extract").status_code == 200
        assert client.post("/api/extraction", json={}).status_code == 403
        headers = {"X-AI-Persona": "1"}
        task = client.post("/api/extraction", headers=headers, json={}).json()
        import base64

        result = client.post(
            f"/api/extraction/{task['id']}/add",
            headers=headers,
            json={
                "revision": task["revision"],
                "filename": "x.md",
                "content": base64.b64encode(b"# Test\n<script>alert(1)</script>").decode(),
            },
        ).json()
        sid = result["members"][0]["source_id"]
        response = client.get(f"/extract/{task['id']}/source/{sid}")
        assert "&lt;script&gt;" in response.text and "<script>" not in response.text
        assert "sandbox" in response.headers["content-security-policy"]
        original = client.get(f"/extract/{task['id']}/source/{sid}?original=true")
        assert "attachment" in original.headers["content-disposition"]


def test_v2_material_migration_is_lossless(service):
    material = next(iter(service.store().of_type(Material)))
    value = material.model_dump(mode="json", by_alias=True)
    value["schema"] = "ai-persona.material/v2"
    migrated = Material.model_validate(value)
    assert migrated.user_relationships == material.user_relationships
    assert migrated.schema_id == "ai-persona.material/v3"


def test_changed_source_and_late_phase_are_rejected(service):
    task = add(service)
    sid = task["members"][0]["source_id"]
    run = phase(service, task, sid)
    with pytest.raises(AgentServiceError, match="阶段"):
        service.tool(task["id"], run, {"action": "overview"}, expected_phase="old-phase")
    path = service.store().source_file_path(sid, "attachments/structured.md")
    path.write_text("tampered", encoding="utf-8")
    with pytest.raises(AgentServiceError, match="改变"):
        service.tool(task["id"], run, {"action": "read", "source_id": sid})


def test_full_reading_and_partial_checkpoint_resume(service):
    task = add(service, text="# Long\n" + "A line about the method.\n" * 220)
    task = service.modify(
        task["id"], task["revision"], policy={**task["policy"], "reading": "full"}
    )
    sid = task["members"][0]["source_id"]
    run = phase(service, task, sid)
    service.tool(task["id"], run, {"action": "read", "source_id": sid, "count": 80})
    with pytest.raises(AgentServiceError, match="81"):
        service.tool(
            task["id"],
            run,
            {"action": "checkpoint", "source_id": sid, "analysis": {"summary": "Partial read"}},
        )
    service.tool(
        task["id"],
        run,
        {
            "action": "checkpoint",
            "source_id": sid,
            "analysis": {"summary": "Partial read", "complete": False},
        },
    )
    service.cancel(task["id"])
    task = service.modify(task["id"], task["revision"], retry=task["members"][0]["id"])
    assert service.repository.get(task["id"])["members"][0]["analysis"]["summary"] == "Partial read"


def test_crash_after_proposal_commit_recovers_without_regeneration(service):
    task = add(service)
    service.backend = FixtureBackend()
    run = service.start(task["id"], task["revision"])
    service.run(task["id"], run)
    saved = service.view(task["id"])["submissions"][0]["change_set_id"]
    # Simulate task DB rollback after the separately durable proposal commit.
    with service.repository.edit(task["id"]) as current:
        current.update(status="paused", submissions=[], phase_done=False)
    recovered = service.view(task["id"])
    assert recovered["status"] == "review"
    assert recovered["submissions"][0]["change_set_id"] == saved


def test_arxiv_html_first_and_pinned_version(service, monkeypatch):
    from test_material_imports import _atom

    from ai_persona.material_imports import arxiv

    requests = []

    def read(url, **kwargs):
        requests.append(url)
        if "api/query" in url:
            return _atom("v2"), url
        assert "/html/" in url
        return (
            b'<html><article><h1>Paper</h1><section id="S1"><h2>Method</h2><p>Named algorithm.</p></section></article></html>',
            url,
        )

    monkeypatch.setattr(arxiv, "_read_official_url", read)
    task = service.repository.create()
    task = service.add(task["id"], task["revision"], arxiv="https://arxiv.org/html/2601.12345v2")
    member = task["members"][0]
    assert member["version"] == "v2" and member["url"].endswith("v2")
    assert all("/pdf/" not in url for url in requests)
    assert member["index"]["sections"][-1]["anchor"] == "S1"
    with pytest.raises(arxiv.ArxivImportError, match="版本"):
        arxiv.fetch_arxiv_document("2601.12345v1", prefer_html=True)


def test_isolated_runtime_and_internal_hook(monkeypatch, tmp_path):
    from ai_persona.codex_hook import process_input
    from ai_persona.extraction.backend import isolated_config, runtime_config

    isolated = tmp_path / "isolated"
    isolated.mkdir()
    (isolated / "config.toml").write_text('[mcp_servers.other]\ncommand="other"\nenabled=true\n')
    config = isolated_config(isolated)
    assert config["mcp_servers"]["other"]["enabled"] is False
    assert config["mcp_servers"]["other"] == {"enabled": False}
    assert config["features"]["shell_tool"] is False
    assert config["features"]["codex_hooks"] is False
    assert runtime_config(codex_home=isolated).env["CODEX_HOME"] == str(isolated)
    monkeypatch.setenv("AI_PERSONA_INTERNAL_EXTRACTION", "1")
    assert process_input(None, None, None, "unused", {}) is None


def test_scanned_pdf_is_flagged_and_original_page_can_be_verified(service):
    import base64
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (100, 100), "white").save(buffer, format="PDF")
    task = service.repository.create()
    task = service.add(task["id"], task["revision"], filename="scan.pdf", content=buffer.getvalue())
    member = task["members"][0]
    assert member["warnings"] and member["index"]["sections"][0]["page"] == 1
    run = phase(service, task, member["source_id"])
    page = service.tool(
        task["id"], run, {"action": "page", "source_id": member["source_id"], "page": 1}
    )
    assert base64.b64decode(page["image"]).startswith(b"\x89PNG")
    assert "basis_ref" not in page


def test_internal_batch_can_exceed_public_transport_limit(service):
    task = add(service)
    task = service.modify(
        task["id"],
        task["revision"],
        policy={**task["policy"], "collect_materials": False, "max_nodes": 100},
    )
    sid = task["members"][0]["source_id"]
    run = phase(service, task, sid)
    basis = service.tool(task["id"], run, {"action": "read", "source_id": sid})["basis_ref"]
    changes = [
        candidate(
            f"n{i}", basis, values={"title": f"Fixture concept {i}", "semantic_role": "concept"}
        )
        for i in range(51)
    ]
    service.tool(
        task["id"],
        run,
        {
            "action": "checkpoint",
            "source_id": sid,
            "analysis": {"summary": "Batch transport fixture", "changes": changes},
        },
    )
    with service.repository.edit(task["id"]) as current:
        current["phase"] = "merge"
    result = service.tool(
        task["id"],
        run,
        {
            "action": "submit",
            "draft": {"kind": "propose", "summary": "Batch transport fixture", "changes": changes},
        },
    )
    assert len(result["submissions"][0]["proposals"]) == 51


def test_scoped_mcp_protocol_exposes_no_publish_tools(service):
    import asyncio

    from mcp import Client

    from ai_persona.extraction.mcp import create_server

    task = add(service)
    sid = task["members"][0]["source_id"]
    run = phase(service, task, sid)

    async def scenario():
        async with Client(
            create_server(service.data_root, service.state_root, task["id"], run, sid)
        ) as client:
            tools = await client.list_tools()
            assert [t.name for t in tools.tools] == ["persona_extract"]
            result = await client.call_tool(
                "persona_extract", {"request": {"action": "read", "source_id": sid}}
            )
            assert not result.is_error and "basis_ref" in result.content[0].text
            service.cancel(task["id"])
            late = await client.call_tool("persona_extract", {"request": {"action": "overview"}})
            assert late.is_error and "cancelled" in late.content[0].text

    asyncio.run(scenario())


def test_failed_tool_attempts_count_and_budget_pause_is_durable(service):
    task = add(service)
    sid = task["members"][0]["source_id"]
    run = phase(service, task, sid)
    with pytest.raises(AgentServiceError):
        service.tool(task["id"], run, {"action": "read", "source_id": "outside"})
    assert service.repository.get(task["id"])["tool_calls"] == 1
    with service.repository.edit(task["id"]) as current:
        current["tool_calls"] = 500
    with pytest.raises(AgentServiceError, match="上限"):
        service.tool(task["id"], run, {"action": "overview"})
    paused = service.repository.get(task["id"])
    assert paused["status"] == "paused" and paused["run_id"] is None


def test_budget_is_audited_and_start_rejects_mismatch(service):
    task = add(service)
    assert task["policy"]["max_nodes"] == 20
    with pytest.raises(AgentServiceError, match="上限"):
        service.start(task["id"], task["revision"], expected_max_nodes=1)
    assert service.repository.get(task["id"])["status"] != "running"
    task = service.modify(task["id"], task["revision"], policy={**task["policy"], "max_nodes": 7})
    changed = next(e for e in task["events"] if e["kind"] == "policy_changed")
    assert (changed["before_max_nodes"], changed["after_max_nodes"]) == (20, 7)
    service.start(task["id"], task["revision"], expected_max_nodes=7)
    saved = service.repository.get(task["id"])
    assert saved["run_policy"]["max_nodes"] == 7
    assert saved["events"][-1]["max_nodes"] == 7


def test_budget_omissions_require_real_source_evidence(service):
    task = add(service, service.repository.create({"collect_materials": False}))
    sid = task["members"][0]["source_id"]
    run = phase(service, task, sid)
    read = service.tool(task["id"], run, {"action": "read", "source_id": sid})
    analysis = {
        "summary": "One concept deferred by budget.",
        "changes": [],
        "budget_omissions": [
            {
                "title": "Similarity graph",
                "reason": "Retain the central method within the node budget.",
                "basis": [{"ref": "invented", "supports": []}],
            }
        ],
    }
    with pytest.raises(AgentServiceError, match="原文依据"):
        service.tool(
            task["id"], run, {"action": "checkpoint", "source_id": sid, "analysis": analysis}
        )
    analysis["budget_omissions"][0]["basis"][0]["ref"] = read["basis_ref"]
    service.tool(task["id"], run, {"action": "checkpoint", "source_id": sid, "analysis": analysis})
    with service.repository.edit(task["id"], run_id=run) as current:
        current["phase"] = "merge"
    overview = service.tool(task["id"], run, {"action": "overview", "source_id": sid})
    assert overview["budget_omissions"] == analysis["budget_omissions"]
    draft = {
        "kind": "no_change",
        "summary": "Budget omissions remain for review.",
        "changes": [],
        "budget_omissions": analysis["budget_omissions"],
    }
    service.tool(task["id"], run, {"action": "submit", "draft": draft})
    view = service.view(task["id"])
    assert view["draft"]["budget_omissions"][0]["title"] == "Similarity graph"
    assert view["evidence"][read["basis_ref"]]["source_id"] == sid


def test_autonomous_reads_any_source_and_submits_without_checkpoints(service):
    task = add(service)
    task = add(
        service, task, text="# Other\nCross-source concepts may be inspected in either order.\n"
    )
    task = service.modify(
        task["id"], task["revision"], policy={**task["policy"], "collect_materials": False}
    )
    run = phase(service, task, "autonomous")
    # The model may start with the last source and then cross back without overview or a source phase.
    refs = [
        service.tool(task["id"], run, {"action": "read", "source_id": m["source_id"]})["basis_ref"]
        for m in reversed(task["members"])
    ]
    value = candidate("cross", refs[0])
    value["basis"].append({"ref": refs[1]})
    result = service.tool(
        task["id"],
        run,
        {
            "action": "submit",
            "draft": {"kind": "propose", "summary": "Cross-source result", "changes": [value]},
        },
    )
    assert result["saved"] and len(result["submissions"][0]["proposals"]) == 1
    assert all(m["analysis"] is None for m in service.repository.get(task["id"])["members"])


def test_repeated_source_excerpt_charged_once_in_evidence_budget(service):
    task = add(service, text="# Shared source\n" + "An established method. " * 340)
    task = service.modify(
        task["id"],
        task["revision"],
        policy={**task["policy"], "max_nodes": 80, "collect_materials": False},
    )
    run = phase(service, task, "autonomous")
    ref = service.tool(
        task["id"], run, {"action": "read", "source_id": task["members"][0]["source_id"]}
    )["basis_ref"]
    changes = [
        candidate(
            "concept" + str(i),
            ref,
            values={
                "title": "Method " + str(i),
                "summary": "Test evidence budget",
                "semantic_role": "method",
            },
        )
        for i in range(80)
    ]
    result = service.tool(
        task["id"],
        run,
        {
            "action": "submit",
            "draft": {"kind": "propose", "summary": "Shared source references", "changes": changes},
        },
    )
    assert result["saved"] and len(result["submissions"][0]["proposals"]) == 80


def test_output_contract_available_without_overview_and_errors_are_actionable(service):
    from ai_persona.extraction.contracts import output_contract
    from ai_persona.extraction.service import safe_error
    from ai_persona.proposals import ProposalError

    task = service.repository.create(policy={"collect_materials": False})
    task = add(service, task)
    run = phase(service, task, "autonomous")
    schema = service.tool(task["id"], run, {"action": "schema"})
    assert schema == output_contract()
    node = schema["entities"]["knowledge_node"]
    assert "semantic_role" in node["required_on_create"]
    assert "summary" in node["properties"] and "description" not in node["properties"]
    assert "knowledge_level" not in node["properties"]
    assert all("evidence_refs" not in c["properties"] for c in schema["entities"].values())
    assert schema["tool_limits"]["read_count_max"] == 200
    assert "covers" in schema["entities"]["relation"]["properties"]["relation_type"]["enum"]
    basis = service.tool(
        task["id"], run, {"action": "read", "source_id": task["members"][0]["source_id"]}
    )["basis_ref"]
    invalid = candidate("node", basis, values={"title": "A concept", "description": "Bad field"})
    with pytest.raises(ProposalError) as exc:
        service.tool(
            task["id"],
            run,
            {
                "action": "submit",
                "draft": {"kind": "propose", "summary": "A concept", "changes": [invalid]},
            },
        )
    assert "description" in safe_error(exc.value)
    assert not service.repository.get(task["id"])["submissions"]
    invalid["values"] = {
        "title": "A concept",
        "semantic_role": "concept",
        "summary": "Correct field",
    }
    result = service.tool(
        task["id"],
        run,
        {
            "action": "submit",
            "draft": {"kind": "propose", "summary": "A concept", "changes": [invalid]},
        },
    )
    assert result["saved"] and len(result["submissions"][0]["proposals"]) == 1


def test_output_language_defaults_snapshots_and_validation(service):
    from pydantic import ValidationError

    from ai_persona.extraction.contracts import Policy

    assert Policy().output_language == "zh"
    with pytest.raises(ValidationError):
        Policy(output_language="fr")
    service.repository.save_policy(
        {**service.repository.policy().model_dump(), "output_language": "en"}
    )
    task = add(service)
    assert task["policy"]["output_language"] == "en"
    service.repository.save_policy(
        {**service.repository.policy().model_dump(), "output_language": "zh"}
    )
    assert service.repository.get(task["id"])["policy"]["output_language"] == "en"
    service.start(task["id"], task["revision"])
    assert service.repository.get(task["id"])["run_policy"]["output_language"] == "en"
