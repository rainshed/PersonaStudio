# Connect Codex to the PersonaStudio Hook

Use **Copy Hook setup instructions** in Studio → Settings → App connections, then paste into your everyday Codex. Codex should execute this guide for the supplied workspace.

One `UserPromptSubmit` Hook supports automatic preferences and conversation learning. Those features are enabled separately. Installation and its probe need no Persona model account; AI proposals still require human review.

## 1. Check the target and scope

Read the supplied Studio URL's `GET /healthz`. Require `ok: true`, `demo: false`, and the supplied `workspace_id`. Reuse this workspace. Identify the real Codex host, project and effective `CODEX_HOME`.

These steps install locally on macOS/Linux. For another host, SSH or a container, use the installed version's [remote integration guide](https://github.com/rainshed/PersonaStudio/blob/main/docs/INTEGRATIONS.md#remote-codex-over-ssh--ssh-远端-codex) instead of copying local paths.

Read `GET /api/learning/v1/config` and `GET /api/preferences/application/config`. Preserve existing feature choices. Reuse a connection matching the workspace, Codex home and selected project scope. For a new connection, default to **the current project, this prompt only**, with no history scan. Ask for scope only when there is no project or the target is ambiguous.

All Studio writes use JSON and these headers:

```text
Content-Type: application/json
X-AI-Persona: 1
X-Persona-Workspace: <workspace_id from the supplied context>
```

## 2. Save the connection

Check `GET /api/learning/v1/codex/environment?home=<URL-encoded absolute CODEX_HOME>`.

For a new connection, POST to `/api/learning/v1/codex/connections` using this body, replacing the sample ID and paths with your confirmed values:

```json
{
  "expected_revision": "",
  "connection": {
    "id": "codex-my-project",
    "name": "My Codex",
    "adapter": "codex",
    "enabled": true,
    "scope_mode": "restricted",
    "trust_user_messages": false,
    "allowed_scopes": ["my-project"],
    "adapter_config": {
      "codex_home": "/absolute/codex/home",
      "project_scopes": {"/absolute/project": "my-project"},
      "transcript_roots": []
    }
  }
}
```

An enabled source receives its selected scope. If learning is already enabled globally, enable a new source only when the user has authorized learning for that scope; otherwise save it disabled and report that enabling/verification remains pending. Do not disable other connections to run a test.

For an existing connection, GET `/api/learning/v1/connections/<id>/setup`, preserve its complete `connection`, and use `connection_revision` as `expected_revision`. On a conflict, reread before merging.

## 3. Install with Studio's installer

GET that connection's `/setup` again. Check `environment.codex_home`, `installation.path` and the generated command's absolute paths.

- If `installation.installed` is true, skip the write.
- Otherwise require `installation.can_install: true`, then POST `/setup/install` with `{"revision": <installation.revision>}`. Preserve the revision's JSON type, including null.
- Require `installation.installed: true` in the result. Record `backup` and `changed`. The installer backs up an existing file and merges this connection's Hook while retaining other handlers. A second installation should return `changed: false`.

Invalid JSON, symlinks, disabled Hooks or stale revisions need investigation; do not replace the entire file or bypass the installer. Check other loaded Hook sources for a duplicate of this same connection.

## 4. Review, trust and verify

Ask the user to review the installed Persona command in Codex's Hook controls (`/hooks` in the CLI). New or changed definitions require trust. Reload the target session if needed. Do not edit trust records or bypass trust to claim a successful normal installation.

Once the source is enabled and installed:

1. POST `/api/learning/v1/connections/<id>/setup/probe` with `{}`.
2. Send the returned `probe.message` **unchanged as a new user message in the target Codex**, in the allowed project. It expires after 15 minutes. Do not simulate Hook input or invoke its command yourself as a substitute for this test.
3. GET `/setup`. Success requires `probe.status: "received"`, `scope_ok: true`, and `context_status: "disabled"` for prompt-only mode (or `"readable"` if history was explicitly selected).

This probe checks Hook delivery without calling Persona models or retaining the message body. Codex still processes the turn normally. If delivery fails, check the actual host/home, trust, enabled source, project scope and command paths.

## 5. Report the result

List the workspace, Codex home, selected scope, backup, and separate results for **installed**, **trusted in Codex**, and **real message received**. Leave unverified steps pending with the next action. Keep automatic preferences and learning at the user's existing choices.

To stop this integration, disable only its source or Hook. To undo installation, remove only this connection's command; restore a whole backup only when no later edits would be lost. Keep other Hooks and Persona data.

If these endpoints are missing, report a Studio version mismatch before upgrading. Reference: [Codex Hook documentation](https://learn.chatgpt.com/docs/hooks).
