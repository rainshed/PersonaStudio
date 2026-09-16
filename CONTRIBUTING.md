# Contributing

PersonaStudio contains independent local applications under `apps/`:

- `ai-persona`: Python application and read-only Persona MCP service.
- `paper-radar`: React interface, Node.js research service, shared host contract and optional DSH plugin.

Prepare Paper Radar and its Persona dependency from the repository root with `npm run setup:radar`. Run `npm start` for the complete local app. Use an isolated `--home` directory when testing changes; never commit personal workspaces, databases, credentials, logs or private backups.

## Checks

- Paper Radar: `npm run check:radar`. This includes actual Persona interface integration and a built-app smoke check without model calls.
- AI Persona: `uv run --no-project --python 3.12 python scripts/check.py`.
- Changes to the application switcher should also cover `apps/ai-persona/tests/test_studio_apps.py`.

Keep UI messages available in Simplified Chinese and English. Preserve old report readers, task snapshots, cancellation behavior and migration compatibility. Both Codex and DSH use the shared research tools; provider-specific code belongs in host adapters.

Use the existing lockfiles. `packages/host-contract` contains portable protocol definitions only; network, authentication and task execution belong in their respective processes. Do not add application imports to the DSH plugin.

The Paper Radar migration is currently awaiting user review. Do not publish a combined release or update the public installer as part of routine development checks. See [local review instructions](docs/PAPER_RADAR.md).
