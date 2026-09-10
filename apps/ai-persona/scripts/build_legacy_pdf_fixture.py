"""Regenerate the original synthetic PDF used by the fixed regression fixture.

Run from apps/ai-persona with the development environment and ReportLab available:
    PYTHONPATH=src uv run --locked --extra dev --with reportlab==5.0.1 python \
        scripts/build_legacy_pdf_fixture.py

This script addresses only tests/fixtures/legacy-demo. It never opens a personal
workspace. Stable fixture IDs and graph relationships intentionally stay fixed.
"""
from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path

import yaml
from reportlab import Version as reportlab_version
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.lib.utils import simpleSplit
from reportlab.pdfgen import canvas

from ai_persona.compiler import PersonaCompiler
from ai_persona.frontmatter import dump_markdown_record
from ai_persona.proposals import record_content_hash
from ai_persona.store import PersonaStore

FIXTURE = Path(__file__).resolve().parents[1] / "tests/fixtures/legacy-demo"
MATERIAL_ID = "mat_a2be3b0ec4a04be39baaf93584e94e0d"
SOURCE_ID = "src_ff89b349649a40769478e69db92d82b6"
PROPOSAL_ID = "prop_612222f43ed34c6b9f7f03a3057851ec"
TITLE = "Synthetic Transport Study"
SUMMARY = "An original fictional PDF for source reading, hashing, and material review tests."
BODY = "# Fixture note\n\nAll content and personal-state fields describe a fictional test persona.\n"


def write_pdf(path: Path) -> None:
    """One page, standard fonts, and invariant metadata make rebuilds repeatable."""
    pdf = canvas.Canvas(str(path), pagesize=letter, invariant=1, pageCompression=0)
    pdf.setTitle(TITLE)
    pdf.setAuthor("PersonaStudio fixture generator")
    pdf.setSubject("Original fictional test material distributed under the MIT license")
    width, height = letter
    left, right = 48, width - 48
    pdf.setFillColor(HexColor("#173E38"))
    pdf.rect(0, height - 160, width, 160, fill=1, stroke=0)
    pdf.setFillColor(HexColor("#B7DED0"))
    pdf.setFont("Helvetica-Bold", 9)
    pdf.drawString(left, height - 52, "PERSONASTUDIO  /  PUBLIC TEST FIXTURE")
    pdf.setFillColor(HexColor("#FFFFFF"))
    pdf.setFont("Helvetica-Bold", 25)
    pdf.drawString(left, height - 91, TITLE)
    pdf.setFont("Helvetica", 11)
    pdf.drawString(left, height - 118, "Original sample material. No real authors, subjects, or research results.")

    y = height - 198

    def section(label: str, text: str) -> None:
        nonlocal y
        pdf.setFillColor(HexColor("#173E38"))
        pdf.setFont("Helvetica-Bold", 13)
        pdf.drawString(left, y, label)
        y -= 24
        pdf.setFillColor(HexColor("#283632"))
        pdf.setFont("Helvetica", 11)
        for line in simpleSplit(text, "Helvetica", 11, right - left):
            pdf.drawString(left, y, line)
            y -= 16
        y -= 26

    section("1. Purpose", "This fictional note provides a small PDF for testing material imports, "
            "source integrity, text extraction, and human review. It is not a scientific publication.")
    section("2. Toy model", "Consider a synthetic chain with twelve sites. A matrix product state "
            "(MPS) is used only as a sample method label. All values below are invented and make "
            "no claim about a physical system or a person's knowledge.")
    pdf.setFillColor(HexColor("#173E38"))
    pdf.setFont("Helvetica-Bold", 13)
    pdf.drawString(left, y, "3. Example observations")
    y -= 30
    rows = [("Step", "Sample value", "Purpose"),
            ("0", "0.00", "Initial placeholder"),
            ("1", "0.25", "Intermediate placeholder"),
            ("2", "0.50", "Final placeholder")]
    for index, row in enumerate(rows):
        pdf.setFillColor(HexColor("#EAF3EF" if index == 0 else "#F5F8F6"))
        pdf.rect(left, y - 9, right - left, 29, fill=1, stroke=0)
        pdf.setFillColor(HexColor("#283632"))
        pdf.setFont("Helvetica-Bold" if index == 0 else "Helvetica", 10)
        for x, value in zip((left + 12, left + 112, left + 252), row, strict=True):
            pdf.drawString(x, y, value)
        y -= 31
    y -= 26
    section("4. Reading check", "The sample can be linked to the fixture's MPS knowledge node. "
            "The relationship tests application behavior; it does not represent real reading history.")
    pdf.setStrokeColor(HexColor("#D1DDD6"))
    pdf.line(left, 66, right, 66)
    pdf.setFillColor(HexColor("#53665C"))
    pdf.setFont("Helvetica", 9)
    pdf.drawString(left, 46, "Created for PersonaStudio tests. MIT license. Entirely fictional.")
    pdf.drawRightString(right, 46, "1 / 1")
    pdf.showPage()
    pdf.save()


def main() -> None:
    if reportlab_version != "5.0.1":
        raise SystemExit("Use ReportLab 5.0.1 for reproducible fixture bytes (see the command above).")
    data = FIXTURE / "persona-data"
    source = data / "sources" / SOURCE_ID
    material = data / "records/materials" / f"{MATERIAL_ID}.md"
    if not source.is_dir() or not material.is_file():
        raise SystemExit("The fixed regression fixture is missing; no files were created.")

    with tempfile.TemporaryDirectory(prefix="persona-synthetic-pdf-") as temporary:
        generated = Path(temporary) / "synthetic.pdf"
        write_pdf(generated)
        content = generated.read_bytes()
    (source / "original.pdf").write_bytes(content)
    checksum = hashlib.sha256(content).hexdigest()
    manifest_path = source / "manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text())
    manifest["origin"]["provider"] = "synthetic-fixture"
    manifest["content_hash"] = checksum
    for entry in manifest["files"]:
        if entry["path"] == "original.pdf":
            entry["sha256"] = checksum
    manifest_path.write_text(yaml.safe_dump(manifest, allow_unicode=True, sort_keys=False))

    metadata = yaml.safe_load(material.read_text().split("---", 2)[1])
    metadata["title"] = TITLE
    metadata["summary"] = SUMMARY
    metadata["bibliography"]["authors"] = ["PersonaStudio Demo Authors"]
    material.write_text(dump_markdown_record(metadata, BODY), encoding="utf-8")

    proposal_path = data / "proposals/history" / f"{PROPOSAL_ID}.json"
    proposal = json.loads(proposal_path.read_text())
    for item in proposal["patch"]:
        if item["field"] == "title":
            item["after"] = TITLE
        elif item["field"] == "summary":
            item["after"] = SUMMARY
        elif item["field"] == "body":
            item["after"] = BODY
        elif item["field"] == "bibliography":
            item["after"]["authors"] = ["PersonaStudio Demo Authors"]
    proposal["reason"] = "Add an original synthetic PDF for regression testing."
    proposal_path.write_text(json.dumps(proposal, ensure_ascii=False, indent=2) + "\n")

    store = PersonaStore(data).load()
    record_hash = record_content_hash(store.records[MATERIAL_ID])
    ledger_path = data / "revisions/changes.jsonl"
    rows = [json.loads(line) for line in ledger_path.read_text().splitlines()]
    for row in rows:
        for change in row.get("changes", []):
            if change.get("object_id") == MATERIAL_ID:
                change["new_hash"] = record_hash
                row["note"] = proposal["reason"]
    ledger_path.write_text("".join(
        json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
        for row in rows
    ))
    with tempfile.TemporaryDirectory(prefix="persona-fixture-index-") as state:
        PersonaCompiler(data, Path(state)).build()
    print(f"Rebuilt the synthetic PDF fixture and projections: {checksum}")


if __name__ == "__main__":
    main()
