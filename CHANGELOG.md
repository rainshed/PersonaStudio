# Changelog

## Unreleased

- Fix local and remote Codex conversation capture when session metadata exceeds 32 KiB. Read metadata up to a separate 1 MiB limit while preserving session identity checks, bounded conversation capture and exclusion of assistant reasoning. Add regression tests for large, oversized and incomplete metadata.
- Update contribution guidance with direct pull requests for small changes and contact information for larger contributions.

## 0.2.0

- Offer AI Persona alone or AI Persona with Paper Radar through one installer. Keep the selected components on update, support adding/removing Radar later, and retain user data and the previous application version.
- Publish a separate Radar component with prebuilt web assets. Prepare a private, checksum-verified Node.js runtime only for Radar, and verify the installed server before activation.
- Add an Extensions page and stable Persona discovery across updates. Release checks now cover both installation combinations and component changes.

- Add Paper Radar as a local PersonaStudio application, retaining its research pages, both analysis hosts and existing data layout.
- Add direct Persona connection → subscription onboarding, application switching, workspace discovery and managed local startup.
- Add verified research backups, separate recovery copies and redacted diagnostics.
- Add mandatory Persona integration and isolated runtime checks.

- Consolidate permanent user documentation into two paired English/Chinese guides and remove duplicate application READMEs, dated validation logs, superseded design documents, and redundant getting-started, architecture, and remote runbook guides.

## 0.1.0

### PersonaStudio repository

- Add a release installer whose single GitHub command handles both first installation and updates. Install verified releases side by side, expose stable `ai-persona` and `ai-persona-mcp` commands, preserve the previous version, and restore it when a restarted Studio fails. Publish deterministic archives, manifests and checksums from version tags after clean installation tests.

- Add downloadable Codex runbooks for Hook installation and MCP configuration in Application access. Accept explicit data/state paths in the MCP entry point so Studio-generated configurations start successfully.

- Add model readiness checks with a return to the original AI task; durable, versioned editor drafts; shared arXiv/Markdown/text-PDF/TXT/pasted-text intake; separate Hook and MCP verification; and named workspaces with a guarded browser switch coordinator. Conversation learning and automatic preferences share one Hook and remain independently enabled. Images remain supporting AI inputs.

- Add preview-and-confirm content initialization that retains connections/settings, plus collection-scoped extraction cleanup with edited/shared-record protection and preserved inputs. Stop active work before clearing, recover interrupted changes, prevent old learning events from replaying, and offer optional portable backups.

- Enforce a shared Studio service lock across foreground, background, installed and source entry points. Repeated starts reuse the active workspace; other workspaces and Demo require stopping it first. Release the service lock on exit or crash, and reuse active Studio when opening setup.

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

This section describes the contents prepared for version 0.1.0. A version is public only after its GitHub Release workflow succeeds.
