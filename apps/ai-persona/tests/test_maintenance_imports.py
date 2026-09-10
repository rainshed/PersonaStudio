"""Real intake, extraction and review adapters; no network or provider calls."""

import base64
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from test_maintenance import Model, candidate, proposed
from test_maintenance import workspace as workspace_fixture
from test_material_imports import _install_fake_arxiv

from ai_persona.agent import AgentServiceError
from ai_persona.ai_service import PersonaAIService
from ai_persona.maintenance.imports import attach_arxiv, attach_file, pdf_text
from ai_persona.maintenance.service import update_input
from ai_persona.material_imports.arxiv import ArxivImportError, normalize_arxiv_link
from ai_persona.models import Course, Evidence, Material
from ai_persona.proposals import ProposalRepository, ProposalService
from ai_persona.store import PersonaStore
from ai_persona.web import create_app

workspace = workspace_fixture


@pytest.mark.parametrize("url", [
    "2601.12345", "arXiv:2601.12345", "https://example.org/paper",
    "https://arxiv.org.evil.test/abs/2601.12345",
    "https://arxiv.org@evil.test/abs/2601.12345",
    "https://user@arxiv.org/abs/2601.12345", "file:///tmp/paper.pdf",
    "https://arxiv.org:8080/abs/2601.12345", None,
])
def test_assistant_accepts_links_only(url):
    with pytest.raises(ArxivImportError, match="目前只支持 arXiv 链接"):
        normalize_arxiv_link(url)


@pytest.mark.parametrize("url", [
    "https://arxiv.org/abs/2601.12345v2",
    "https://arxiv.org/pdf/2601.12345v2.pdf",
    "https://arxiv.org/pdf/hep-th/9901001v2.pdf",
])
def test_paper_link_forms(url):
    assert normalize_arxiv_link(url).requested_version == "v2"


def read_references(payload):
    return {"calls":[{"name":"read_source", "arguments":{"source_id":s["source_id"], "file_id":s["file_id"], "view":"text", "selector":{"lines":{"start":1,"end":min(s["line_count"],20)}}, "max_chars":12000}} for s in payload["sources"] if s["origin"]["kind"] != "user_statement"]}


def source_basis(payload):
    return json.loads(payload["tool_results"][-1]["content"])["result"]["data"]["basis_ref"]


def paper_candidate(payload):
    source = next(s for s in payload["sources"] if s["origin"]["kind"] == "attachment")
    basis = source_basis(payload)
    return proposed(candidate(
        payload, entity_type="material",
        values={"source_ref": source["source_id"], "summary": "A source-grounded summary."},
    ) | {"basis": [{"ref": basis}]})


def collected_paper(workspace, monkeypatch):
    _install_fake_arxiv(monkeypatch, "v1")
    service = PersonaAIService(*workspace, Model(read_references, paper_candidate))
    value = service.create_session(maintenance={"target_types": ["material"]})
    result = attach_arxiv(
        service, value["id"], "https://arxiv.org/abs/2601.12345v1", value["version"],
    )
    value, sid = result["session"], result["source_id"]
    value = update_input(service, value["id"], {
        **value["maintenance"], "collect_attachment_ids": [sid],
        "attachment_relationships": {sid: "read"},
    }, value["version"])
    running = service.begin(value["id"], "收录论文并提取摘要。", value["version"])
    submitted = service.generate(value["id"], running["run_id"])
    assert submitted["status"] == "submitted", submitted.get("error")
    return service, submitted, sid


def test_arxiv_reuses_import_metadata_and_requires_review(workspace, monkeypatch):
    before = PersonaStore(workspace[0]).load()
    service, submitted, sid = collected_paper(workspace, monkeypatch)
    after = PersonaStore(workspace[0]).load()
    assert after.config.revision == before.config.revision
    assert len(after.of_type(Material)) == len(before.of_type(Material))
    manifest = after.sources[sid]
    assert any(f.role == "extracted_text" for f in manifest.files)
    prop = ProposalRepository(workspace[0]).get(
        submitted["submission"]["proposals"][0]["proposal_id"]
    )
    values = {p.field: p.after for p in prop.patch}
    assert values["title"] == "HTML-Friendly Paper"
    assert values["material_type"] == "paper"
    assert values["bibliography"]["authors"] == ["Ada Lovelace", "Grace Hopper"]
    assert values["user_relationships"] == ["read"]
    assert prop.evidence_candidates[0].source_id == sid
    assert not list((workspace[1] / "material-imports").glob("imp_*"))
    ProposalService(*workspace).accept(prop.id)
    assert len(PersonaStore(workspace[0]).load().of_type(Material)) == len(before.of_type(Material)) + 1
    assert service.get_session(submitted["id"])["can_refine"] is False


def test_existing_arxiv_material_reused_and_other_version_needs_review(workspace, monkeypatch):
    service, submitted, _ = collected_paper(workspace, monkeypatch)
    prop_id = submitted["submission"]["proposals"][0]["proposal_id"]
    reviewer = ProposalService(*workspace)
    reviewer.accept(prop_id)
    material_id = ProposalRepository(workspace[0]).get(prop_id).target_id
    value = service.create_session(maintenance={"target_types": ["knowledge_node"]})
    result = attach_arxiv(
        service, value["id"], "https://arxiv.org/pdf/2601.12345v1.pdf", value["version"],
    )
    assert result["existing_material_id"] == material_id
    assert result["session"]["maintenance"]["material_ids"] == [material_id]
    assert not result["session"]["attachments"]
    _install_fake_arxiv(monkeypatch, "v2")
    value = result["session"]
    result = attach_arxiv(
        service, value["id"], "https://arxiv.org/abs/2601.12345v2", value["version"],
    )
    assert result["import_review_url"].startswith("/materials/imports/imp_")
    assert result["session"]["version"] == value["version"]


def test_file_and_arxiv_api_with_owned_source_previews(workspace, monkeypatch):
    _install_fake_arxiv(monkeypatch, "v1")
    app = create_app(*workspace)
    app.state.ai_service.model = Model()
    headers = {"X-AI-Persona": "1"}
    with TestClient(app) as client:
        page = client.get("/ai")
        assert page.status_code == 200 and "ai-arxiv-url" in page.text
        assert "或论文 ID" not in page.text
        value = client.post("/api/ai/sessions", json={
            "maintenance": {"target_types": ["knowledge_node"]},
        }, headers=headers).json()
        endpoint = "/api/ai/sessions/" + value["id"]
        rejected = client.post(endpoint + "/arxiv", json={
            "url": "https://example.org", "version": value["version"],
        }, headers=headers)
        assert rejected.status_code == 400
        assert rejected.json()["error"]["message"] == "目前只支持 arXiv 链接"
        assert client.get(endpoint).json()["version"] == value["version"]
        result = client.post(endpoint + "/file", json={
            "filename": "notes.md", "content_base64": base64.b64encode(b"# Notes\nDefinition.").decode(),
            "version": value["version"],
        }, headers=headers).json()
        source_id = result["source_id"]
        source = client.get(endpoint + "/sources/" + source_id + "?view=text")
        assert source.status_code == 200 and source.text == "# Notes\nDefinition."
        second = client.post("/api/ai/sessions", json={
            "maintenance": {"target_types": ["knowledge_node"]},
        }, headers=headers).json()
        assert client.get("/api/ai/sessions/" + second["id"] + "/sources/" + source_id).status_code == 400
        assert not app.state.ai_service.model.calls


def test_image_transcription_keeps_original_and_marks_uncertainty(workspace):
    class Vision:
        def step(self, task, system, messages, tools, **kwargs):
            assert task == "material" and not tools
            assert messages[0]["content"][1]["type"] == "image"
            return {"text": json.dumps({"text": "# Course\n1. Linear algebra", "warnings": ["Date is unclear."]})}

    service = PersonaAIService(*workspace, Vision())
    value = service.create_session(maintenance={"target_types": ["course"]})
    picture = io.BytesIO()
    Image.new("RGB", (20, 20), "white").save(picture, format="PNG")
    result = attach_file(service, value["id"], "course.png",
                         base64.b64encode(picture.getvalue()).decode(), value["version"])
    source = result["session"]["attachments"][0]
    assert "图片文字由模型识别" in source["warnings"][0]
    store = PersonaStore(workspace[0]).load()
    manifest = store.sources[result["source_id"]]
    assert store.source_file_path(manifest.id, manifest.canonical_file).read_bytes() == picture.getvalue()
    assert "Linear algebra" in store.source_file_path(manifest.id, source["file"]).read_text()
    assert not ProposalRepository(workspace[0]).list_pending()


def test_pdf_page_text_is_locatable():
    # A tiny valid PDF with visible text, exercising the actual PDF reader.
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    stream = b"BT /F1 12 Tf 20 260 Td (Course outline: linear algebra) Tj ET"
    objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
    content, offsets = b"%PDF-1.4\n", [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(content))
        content += str(i).encode() + b" 0 obj\n" + obj + b"\nendobj\n"
    xref = len(content)
    content += b"xref\n0 6\n0000000000 65535 f \n"
    content += b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets[1:])
    content += b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n" + str(xref).encode() + b"\n%%EOF\n"
    extracted = pdf_text(content).content.decode()
    assert "第 1 页" in extracted and "Course outline: linear algebra" in extracted


def test_course_syllabus_evidence_survives_review(workspace):
    model = Model(read_references, lambda p: proposed(candidate(p, entity_type="course", values={
        "title": "Linear algebra", "description": "An introductory course.",
        "syllabus": "1. Vector spaces\n2. Linear maps", "interest_level": "unspecified",
    }) | {"basis": [{"ref": source_basis(p)}]}))
    service = PersonaAIService(*workspace, model)
    value = service.create_session(maintenance={"target_types": ["course"]})
    result = attach_file(service, value["id"], "syllabus.md", base64.b64encode(
        b"# Linear algebra\n1. Vector spaces\n2. Linear maps"
    ).decode(), value["version"])
    value = result["session"]
    running = service.begin(value["id"], "整理课程名称和大纲。", value["version"])
    value = service.generate(value["id"], running["run_id"])
    assert value["status"] == "submitted", value.get("error")
    proposal = ProposalRepository(workspace[0]).get(
        value["submission"]["proposals"][0]["proposal_id"]
    )
    before = PersonaStore(workspace[0]).load()
    assert proposal.target_id not in before.records
    ProposalService(*workspace).accept(proposal.id)
    store = PersonaStore(workspace[0]).load()
    course = store.records[proposal.target_id].record
    assert isinstance(course, Course) and course.syllabus.startswith("1. Vector spaces")
    assert course.knowledge_level == course.interest_level == "unspecified"
    assert any(
        proposal.target_id in e.supports and e.source_id == result["source_id"]
        for e in store.of_type(Evidence)
    )


def test_long_source_is_read_on_demand_and_resumes(workspace):
    model = Model(
        read_references, AgentServiceError("timeout", "Retry this turn"),
        lambda p: proposed(candidate(p, entity_type="knowledge_node", values={
            "title": "New source concept", "summary": "A source-grounded concept.",
            "semantic_role": "concept",
        }) | {"basis": [{"ref": source_basis(p)}]}),
    )
    service = PersonaAIService(*workspace, model)
    value = service.create_session(maintenance={"target_types": ["knowledge_node"]})
    content = ("MPS defines a tensor network representation of a quantum state.\n" * 250).encode()
    result = attach_file(service, value["id"], "long-notes.md",
                         base64.b64encode(content).decode(), value["version"])
    value = result["session"]
    running = service.begin(value["id"], "提取定义并保留出处。", value["version"])
    failed = service.generate(value["id"], running["run_id"])
    assert failed["status"] == "failed", failed.get("error")
    assert "segment" not in model.calls[0]
    assert not model.calls[0]["analysis_parts"]
    assert all(block["data"].get("source_id") != result["source_id"] for block in model.calls[0]["source_content"])
    assert failed["checkpoint"]["ledger"]["coverage"][result["source_id"]]
    running = service.resume(value["id"], failed["version"])
    submitted = service.generate(value["id"], running["run_id"])
    assert submitted["status"] == "submitted", submitted.get("error")
    assert len(model.calls) == 3 and "segment" not in model.calls[-1]
    assert not model.calls[-1]["analysis_parts"]
    assert model.calls[-1]["tool_results"]
    proposal = ProposalRepository(workspace[0]).get(
        submitted["submission"]["proposals"][0]["proposal_id"]
    )
    assert proposal.evidence_candidates[0].source_id == result["source_id"]
