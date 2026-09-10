# PersonaStudio

[简体中文](README.zh-CN.md)

A home for personal AI tools that keep your knowledge, preferences, and decisions under your control.

The first application is **AI Persona**: a local knowledge and preference workspace with a browser interface, an AI maintenance assistant, and MCP access for agents. Manual edits take effect when you save; changes proposed by AI wait for your review.

![AI Persona Studio overview](docs/images/studio-overview.png)

## Start here

After downloading or cloning this repository, open a terminal at its root. Install [uv](https://docs.astral.sh/uv/getting-started/installation/) if needed, then run:

```sh
./scripts/ai-persona setup
```

The local setup guide helps you choose a workspace. Keep personal data outside this repository. The application and its commands remain named `ai-persona`.

To explore the included fictional persona first:

```sh
./scripts/ai-persona start --demo
```

The Demo prefers port **8766** and automatically uses an available port if it is occupied. It uses its own editable copy of the sample data. No model account is needed to browse or manually edit it.

## What you can do

- Organize knowledge, courses, reading materials, relationships, and reusable preferences.
- Explore a knowledge graph, inspect original sources, and keep a reviewable edit history.
- Ask an AI assistant to organize material or propose changes, then review its work.
- Connect Codex for scoped knowledge retrieval, optional conversation learning, and preference application.
- Collect explicit feedback, build personal test cases, and compare improvements in isolated evaluations.
- Use the interface in English or Simplified Chinese.

See the [page and feature compatibility matrix](docs/FEATURE_PARITY.md) for the complete retained surface.

## Requirements

| Component | Requirement |
| --- | --- |
| Operating system | macOS or Linux target; native Windows is unsupported. WSL requires separate environment validation. |
| Python | 3.12 or later; the launcher installs the locked application environment through uv. |
| Node.js | 22.19 or later, with npm, for AI model features. |
| Model account | Optional. Manual knowledge and preference management works without one. |

AI features have a separate, explicit installation step:

In **Settings → Models**, follow the environment check, click **Install model components**, then add an account, authenticate, test and save. The command-line alternative is:

```sh
./scripts/ai-persona models-install
```

See [supported authentication methods](docs/MODEL_CONNECTIONS.md). The model runtime is installed outside the Python package. A connection test makes a real provider request and may use your account quota.

To check the local environment:

```sh
./scripts/ai-persona doctor --demo
```

## Repository layout

```text
PersonaStudio/
├── apps/
│   └── ai-persona/      # The application, its lockfile, source, tests, and sample data
├── scripts/            # Repository launcher and checks
├── docs/               # Getting started, data management, and compatibility
└── .github/            # Contribution and automation configuration
```

Only `ai-persona` is included today. Paper Radar and Promptbench may become sibling applications later; they are not bundled dependencies or placeholder applications. The existing **Prompt Workbench** integration points to a separately running service; read the [integration guide](docs/INTEGRATIONS.md) before using it.

## Documentation

- [Delivery validation](docs/VALIDATION.md)

- [Getting started](docs/GETTING_STARTED.md) · [中文上手指南](docs/GETTING_STARTED.zh-CN.md)
- [Data, migration, and backups](docs/DATA_MANAGEMENT.md)
- [MCP, Codex, remote access, and Prompt Workbench](docs/INTEGRATIONS.md)
- [Application documentation](apps/ai-persona/README.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Changes](CHANGELOG.md)

Personal workspaces, model credentials, and deployment logs do not belong in this repository. The included Demo is fictional. This repository uses the [MIT license](LICENSE); bundled third-party assets retain their [own licenses](docs/THIRD_PARTY_NOTICES.md).
