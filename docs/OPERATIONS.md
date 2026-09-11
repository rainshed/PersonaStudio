# Operations and data

[简体中文](OPERATIONS.zh-CN.md) · [Repository home](../README.md)

## Model connections

AI features are optional. Open **Settings → Models** to install components, add an account, authenticate, test a model, and save the default.

| Provider | Available authentication |
| --- | --- |
| OpenAI API | API key |
| ChatGPT / Codex | Browser or device-code account login |
| Claude, Gemini, DeepSeek | API key |
| OpenRouter | API key or account login |
| Moonshot / Kimi open platform | API key |
| Kimi For Coding | Dedicated key or account login |
| Compatible custom service | API key or an explicitly unauthenticated local service |

This is an application support list, not a guarantee that a particular account, region, subscription, or model has provider access. A successful test applies only to the selected connection revision and model. Editing a connection or reauthorizing it invalidates the earlier verification.

Credentials are encrypted in a local account directory. Keep that directory private: its encryption key is local too. Runtime installation does not read or delete credentials, and Demo accounts remain separate from real-workspace accounts.

For detailed installation output:

```sh
ai-persona models-install
ai-persona models-stop
```

## Workspace contents

Keep every real workspace outside the application installation.

| Location | Contents |
| --- | --- |
| `<workspace>/persona-data/records` | Effective knowledge, courses, materials, preferences, tags, relations, and evidence |
| `<workspace>/persona-data/sources` | Original sources, extracted representations, and manifests |
| `<workspace>/persona-data/proposals` and `revisions` | Pending candidates and review history |
| `<workspace>/persona-data/evaluations` | Feedback cases, frozen suites, and saved evaluation artifacts |
| `<workspace>/persona-data/generated` | Rebuildable human and agent projections |
| `<workspace>/persona-state` | Indexes plus durable drafts, AI sessions, extraction state, and prompt experiments |
| External learning directory | Conversation-learning queue and state associated with the workspace |
| Model and runtime directories | Shared credentials, optional runtime components, and rebuildable model caches |

Do not treat all of `persona-state` as disposable cache. Standard backups include workspace data, state, and the associated learning store, but exclude global model credentials.

## Back up, restore, and migrate

Finish active work and stop writers before making a consistent copy:

```sh
PERSONA_WORKSPACE="$HOME/PersonaWorkspaces/main"
ai-persona learning stop-worker --workspace "$PERSONA_WORKSPACE"
ai-persona stop --workspace "$PERSONA_WORKSPACE"

mkdir -p "$HOME/PersonaBackups"
ai-persona backup \
  --workspace "$PERSONA_WORKSPACE" \
  --output "$HOME/PersonaBackups/main.tar.gz"
```

Use a new archive name each time. Backups contain private text, sources, drafts, and history; keep them outside the workspace and never commit them.

Restore always uses a new destination:

```sh
ai-persona restore "$HOME/PersonaBackups/main.tar.gz" \
  --workspace "$HOME/PersonaWorkspaces/restored"
ai-persona validate --workspace "$HOME/PersonaWorkspaces/restored"
ai-persona start --workspace "$HOME/PersonaWorkspaces/restored"
```

Migration also copies into a new directory and leaves the source unchanged:

```sh
ai-persona migrate \
  --from "$HOME/ExistingPersona" \
  --workspace "$HOME/PersonaWorkspaces/migrated"
ai-persona validate --workspace "$HOME/PersonaWorkspaces/migrated"
```

After restoring or migrating, inspect important records and reconnect only the integrations and automatic features you intend to use.

## Reset content

Use **Settings → Data management → Clear content, keep settings** to preview a workspace reset. It clears Persona content and processing history while retaining model connections, authentication, application access, language, prompts, and defaults. A backup is optional and disabled by default; without one, a completed reset cannot be undone.

The extraction workspace also provides **Clear this extraction** for one material collection. Inputs remain available, while records that were edited later or are referenced elsewhere are protected. Both operations stop active tasks, require a current preview and explicit confirmation, and roll back failed writes.

## Update or remove

Run the installation command again to update. The installer verifies the new release, retains the previous application version, and switches only after a smoke check. It does not move workspace data.

```sh
curl -fsSL https://github.com/rainshed/PersonaStudio/releases/latest/download/install.sh | sh
```

There is no all-in-one uninstall command. Stop Studio, learning, the model service, and remote tunnels; remove only AI Persona entries from configured clients; then remove the application version through the installation location. Workspaces, model accounts, and caches are separate and are not deleted automatically.

## Troubleshooting

Start with:

```sh
ai-persona doctor
ai-persona status
ai-persona logs
```

| Symptom | Check |
| --- | --- |
| No workspace is configured | Run `ai-persona setup`, pass `--workspace`, or use `--demo`. |
| The browser shows an older version | A healthy process may have been reused. Finish active work, stop it, and start again. |
| Studio opens on another port | Automatic startup chooses an available port. Use `status` to read the actual address. |
| An explicit port is busy | Choose another port or omit `--port`; foreground `serve` and gateway ports remain fixed. |
| Model runtime is missing | Install Node.js 22.19 or later with npm, run `models-install`, and retry. |
| Authentication or a model test fails | Check the exact account, model access, region, quota, and reported provider error. |
| First semantic search is slow | Allow time for the local embedding model download and initial workspace index. |
| Learning or preferences do not trigger | Check source scope, Hook trust, independent feature switches, model configuration, and worker state. |
| Remote page returns 403 | Match `AI_PERSONA_PUBLIC_ORIGIN` exactly to the external scheme, host, and port. |
| Backup or restore is refused | Stop writers, choose a new destination, and resolve the reported safety check. |

Logs may contain personal paths and request details. Share only the necessary redacted excerpt, never a complete workspace, model store, or conversation archive.
