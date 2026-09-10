# Getting started

[简体中文](GETTING_STARTED.zh-CN.md) · [Repository home](../README.md)

Run the commands below from the PersonaStudio repository root. The launcher uses the application's lockfile and installs a regular Python package through uv. This avoids a separate virtual-environment activation step and editable-install problems in synced folders.

## 1. Install the essentials

Use macOS or Linux with [uv installed](https://docs.astral.sh/uv/getting-started/installation/). The application requires Python 3.12 or later; uv manages the Python environment. Native Windows is not supported because process management and file locks currently use POSIX APIs. WSL is a possible Linux environment, but browser access, file permissions, and application integrations need validation on that machine.

Node.js 22.19 or later, with npm, is required when enabling AI model features. It is not needed just to browse or manually edit a persona.

## 2. Choose a workspace

```sh
./scripts/ai-persona setup
```

The local browser guide lets you try the Demo, create an empty workspace, or open an existing workspace. Choose an absolute folder outside the source repository, such as a `PersonaWorkspaces` folder in your home directory. Creating a workspace does not overwrite a nonempty folder. Opening an existing workspace does not copy it; use the [migration guide](DATA_MANAGEMENT.md) when you want a separate copy.

The guide does not install Codex Hooks or turn on conversation learning. Those are separate choices in Settings. The sidebar workspace menu can create, open and switch workspaces through an independent coordinator; active work blocks switching and existing Hook/MCP bindings stay unchanged.

For a direct Demo launch:

```sh
./scripts/ai-persona start --demo
```

The Demo prefers port 8766 and automatically selects an available port when it is occupied. The browser opens the actual address, and unrelated services or remote gateways can keep running. Use the workspace menu to switch to the Demo after the active-task check. The fictional research persona contains knowledge, reading materials, preferences, and positive/negative examples. Edits are saved to an isolated local copy; the distributed template is unchanged. Model connections and automatic application access are isolated from your real persona.

## 3. Try the everyday workflow

1. Open **Knowledge** and inspect a node in the graph.
2. Open **Materials**, read a sample source, and inspect its related knowledge.
3. Open **Preferences** and edit a rule or example. Saving a manual edit makes it effective immediately and records history.
4. If AI is configured, ask **AI maintenance** to propose an improvement. Open **Feedback & review** to inspect, edit, accept, reject, or defer the candidates.

**Evaluation & improvement** contains test cases, evaluation runs, reports, and improvement references. Explicit feedback creates personal test cases; merely reviewing a proposal is a separate action.

Ordinary content forms keep workspace-local editor drafts after roughly one second of inactivity. Reloading or switching language offers recovery; tabs have independent drafts, and changes to the formal record require comparison before restoration. Saving a draft does not publish content. Files not yet uploaded must be selected again. Uploaded import sources remain available while an unfinished editor refers to them.

**Add materials** accepts arXiv, Markdown, text PDFs, UTF-8 TXT and pasted text (files up to 20 MB; PDFs up to 500 pages). Preview the source, then save it, send it to maintenance or use it in Codex extraction. No analysis starts automatically. PDFs without reliable text require another text source; images remain supporting inputs in the AI assistant.

## 4. Enable AI when you need it

A new real workspace starts with a display name and a recommended data location; its internal ID is generated automatically. Choose a next step: manual editing (the default), extraction with Codex, model setup or application access. Demo retains its optional AI setup flow. **Settings → Models** guides you through:

1. **Prepare:** check Node.js and model components. Install Node.js LTS 22.19 or newer with npm if needed; check again or restart Studio so it can detect the installation. Click **Install model components** in the page. Reloading resumes progress; failed downloads can be retried.
2. **Add account:** choose a provider and its supported API-key or account-login method.
3. **Authenticate:** enter your own key locally, or complete the provider's browser login. Pending authorization can be resumed or cancelled. Saved credentials alone do not imply verified model access.
4. **Test & save:** select the default account/model, run the explicit connection test, and save settings. The test sends a short request, not workspace materials, and may consume account credits. Setup only reports success for a matching successful test of the selected connection revision and model. Changing a connection requires another test.

You can explore and edit manually before setting up AI. See [model connections and authentication](MODEL_CONNECTIONS.md) for supported methods and verification limits.

The terminal alternative also remains available for detailed installation diagnostics:

```sh
./scripts/ai-persona models-install
```

Runtime components live outside the Python package; encrypted account storage is separate. Installation retries do not remove credentials. Demo accounts are isolated. The installation button only works at a local Studio address on the computer running the service; remote users should prepare that computer first.

## 5. Start, diagnose, and stop

After selecting your real workspace in setup:

```sh
./scripts/ai-persona start
./scripts/ai-persona status
./scripts/ai-persona doctor
./scripts/ai-persona stop
```

For the Demo, use `--demo` on the workspace command:

```sh
./scripts/ai-persona doctor --demo
./scripts/ai-persona stop --demo
```

When no `--port` is supplied, `setup` and `start` prefer port 8765 for a real workspace and 8766 for the Demo, then automatically select an available port if needed. A healthy service for the same workspace is reused. Only one Studio service runs for the current OS user. The workspace menu checks tasks and performs the switch; command-line switching requires stopping the current Studio first. Unrelated services and remote gateways can keep running.

An explicit `--port` requests that port and reports a conflict if it cannot be used. Foreground `serve` keeps its fixed-port behavior; it does not automatically choose a different port. `stop` stops Studio; stop background learning or the separate model service when maintaining those components.

```sh
./scripts/ai-persona logs
./scripts/ai-persona models-stop
```

If you have an older global `ai-persona` installation, it is a separate installation. Use the repository launcher consistently during migration. Stop older Studio processes and update the global installation before switching to the Demo. To load this checkout's code into that same existing workspace, finish its active work and restart its service through the new launcher.

## Next steps

- [Data locations, backup, restore, and migration](DATA_MANAGEMENT.md)
- [MCP and application integrations](INTEGRATIONS.md)
- [Feature compatibility matrix](FEATURE_PARITY.md)
- [Troubleshooting](TROUBLESHOOTING.md)
