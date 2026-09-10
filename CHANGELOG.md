# Changelog

## Unreleased

### PersonaStudio repository

- Let Codex choose its own reading strategy across a material collection, with application-provided output contracts and actionable validation errors. Count repeated source excerpts once toward the evidence budget.
- Reuse the home knowledge graph in review, support inline personal-state choices and dependency-aware batch acceptance, and allow direct rejection of pending knowledge proposals from the graph.
- Add Chinese/English extraction output settings with saved defaults and per-task snapshots. Display the node limit prominently and list verified concepts deferred because of it.

- Add Codex material extraction and batch knowledge graphs: arXiv HTML first, bounded file/page reads, editable rules, durable per-source checkpoints, review-gated graph proposals, partial results, cancellation and incremental collections. Preserve evidence provenance and isolate internal tasks from learning Hooks.
- Add lossless Material v2 → v3 reads and an unspecified reading relationship for newly collected material.

- Separate reasoning, text and terminal-event diagnostics and report the numeric output limit actually present in provider requests. Add real Codex adapter fixtures for completion over persistent SSE/WebSocket connections; document the subscription output-budget limitation.

- Keep new errors visible across long pages and dialogs, including failed form requests. Place maintenance errors beside analysis controls and avoid repeated scroll jumps during polling.
- Allow up to seven minutes per foreground maintenance/material model call, bounded by an eight-minute request budget. Distinguish incomplete streaming from saved analysis and retain timing diagnostics.

- Add guided model environment installation, authentication steps and explicit test verification for first-time users. Failed installs can be retried without removing accounts; real provider login remains a user-owned step.

- Organize the existing AI Persona application under `apps/ai-persona` while preserving its application name and command names.
- Add English and Chinese entry documentation, a feature compatibility matrix, contribution guidance, and a project license.
- Separate public source and fictional sample data from personal workspaces and deployment records.
- Document local setup, diagnostics, optional model dependencies, external integrations, and workspace lifecycle operations.
- Let `setup` and `start` reuse a healthy service for the same workspace or automatically choose an available port when the preferred default is occupied. Explicit `--port` requests still report conflicts; foreground `serve` and remote gateway ports remain fixed.

This section describes work prepared in this checkout. It does not announce a published GitHub release, package-registry upload, or successful hosted CI run.
