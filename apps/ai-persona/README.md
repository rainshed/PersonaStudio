# AI Persona

[简体中文](README.zh-CN.md) · [PersonaStudio](../../README.md)

A local, file-first knowledge and preference workspace. Browse your knowledge graph, read original materials, maintain reusable preferences, review AI proposals, and give agents scoped access through MCP.

## Run from this directory

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then use the repository launcher:

```sh
../../scripts/ai-persona setup
```

Or start the fictional Demo:

```sh
../../scripts/ai-persona start --demo
../../scripts/ai-persona doctor --demo
```

The launcher selects this application's lockfile and regular Python installation automatically. Python 3.12+ is required. The target platforms are macOS and Linux; native Windows is unsupported and WSL needs environment-specific validation.

AI model features are optional. **Settings → Models** guides you through environment checks, component installation, account authentication, testing and saving. Install Node.js 22.19+ with npm when prompted; model components can then be installed directly in the page or with `../../scripts/ai-persona models-install`. Model runtime dependencies live outside the Python package. Browsing and manual maintenance work without a model account.

## What is preserved

- Knowledge, courses, materials, original sources, evidence, relationships, and graph navigation.
- Global and contextual preferences, sample resources, manual editing, archival, and history.
- AI maintenance with source references, multi-step candidate generation, and human review.
- A unified feedback/review inbox, personal test cases, isolated evaluations, and improvement references.
- Model settings, task routing, supported provider authentication, and optional fallback.
- Codex Hooks, scoped conversation learning, preference application, local stdio MCP, and authenticated remote HTTP MCP over SSH.
- English/Chinese UI, responsive pages, existing routes, and `ai-persona` / `ai-persona-mcp` command names.

Manual saves take effect immediately and retain history. AI and MCP proposals remain pending until human review. Demo data is a separate copy of the packaged fictional template.

The full [feature compatibility matrix](../../docs/FEATURE_PARITY.md) records the public routes and behavior. Prompt Workbench remains an **external integration**; its application is not bundled here.

## Data stays yours

Keep your workspace outside the repository. Formal records are readable files in `persona-data`; `persona-state` also contains durable drafts and history, so it must not all be treated as disposable cache. Existing data can be opened in place or copied into a new workspace through migration. See [data management](../../docs/DATA_MANAGEMENT.md).

## Documentation

- [Getting started](../../docs/GETTING_STARTED.md)
- [Backup, restore, migration, and updates](../../docs/DATA_MANAGEMENT.md)
- [MCP, Codex, remote access, and Prompt Workbench](../../docs/INTEGRATIONS.md)
- [Troubleshooting](../../docs/TROUBLESHOOTING.md)
- [Detailed application guides and design references](docs/README.md)
- [Demo guide](examples/demo-persona/README.md)
- [Contributing](../../CONTRIBUTING.md) · [Security](../../SECURITY.md) · [License](../../LICENSE)

The application is currently single-user. It includes semantic retrieval and a remote HTTP MCP gateway; native Windows, public multi-user hosting, and a bundled prompt workbench are outside this version's scope.

See [authentication support and account-owned verification](../../docs/MODEL_CONNECTIONS.md).

## Codex material extraction

Open **AI Assistant → Read a paper → Extract knowledge from multiple sources** to combine arXiv links and Markdown/PDF/TXT files. Codex reads bounded source sections, reconciles concepts and submits evidence-backed proposals for human review. Rules, checkpoints, partial results and source provenance are preserved. See the [usage and implementation notes](docs/AI_PERSONA_EXTRACTION_USAGE.zh-CN.md) for limits and the current Chinese extraction interface.
