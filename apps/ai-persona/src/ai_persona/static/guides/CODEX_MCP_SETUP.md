# Connect Codex to PersonaStudio MCP

Use the **Copy MCP setup instructions** button in Studio → Settings → App connections, then paste into the Codex you use. Codex should execute this guide for the supplied workspace.

MCP provides six read-only knowledge/source tools. It needs no Persona model account or Hook. Keep existing permissions and automatic-feature settings.

## 1. Check the target

- Use the supplied Studio URL. Read `GET /healthz`; require `ok: true`, `demo: false`, and the supplied `workspace_id`. Reuse this workspace.
- Identify the actual Codex host and effective `CODEX_HOME`. User configuration is normally `$CODEX_HOME/config.toml`; project configuration is `.codex/config.toml` in a trusted project. Preserve the user's chosen scope.
- These local steps require Codex and Studio on the same macOS/Linux host. A remote browser does not imply remote Codex. For SSH, containers or another host, use the installed version's [remote integration guide](https://github.com/rainshed/PersonaStudio/blob/main/docs/INTEGRATIONS.md#remote-codex-over-ssh--ssh-远端-codex); do not copy local paths to another host.

## 2. Merge the generated configuration

Read `GET /api/studio/mcp-setup`. Use its `config` TOML, including `command`, `args`, `enabled_tools`, `env_vars` and `env.PYTHONPATH`. Retain `env_vars = ["CODEX_HOME"]`: Codex otherwise omits a custom home from its MCP environment, preventing Studio from matching read observations. Verify its data/state paths match the supplied workspace. Studio's web URL is **not** a local MCP endpoint; the generated entry uses stdio.

Back up the existing Codex configuration locally before editing. Merge only the matching server entry, retaining unrelated settings, comments and user restrictions. Reuse a matching entry; if its name belongs to another workspace, choose a distinct name. Stop on invalid TOML or a concurrent edit. Do not overwrite the whole file.

For a new entry, `codex mcp add --help` describes the installed CLI's syntax. After adding it, retain **all** fields from Studio's snippet. For an existing entry, use a targeted TOML edit. Keep absolute paths correctly quoted. Repeating setup should make no changes when the entry already matches.

Reparse the saved TOML. Use `codex mcp get <server-name>` to check the effective entry. This confirms configuration, not an actual tool call.

## 3. Check the service, then the client

Send Studio POST requests with an empty JSON object and these headers:

```text
Content-Type: application/json
X-AI-Persona: 1
X-Persona-Workspace: <workspace_id from the supplied context>
```

1. `POST /api/studio/mcp-setup/diagnose`: require `ok: true`. This checks the server handshake and six-tool catalog; it does not test the target Codex.
2. Reload MCP in that Codex, or open a new session if necessary. The public catalog is `get_knowledge_map`, `search_knowledge`, `get_persona_records`, `list_source_files`, `search_source_content`, `read_source`. The user's tool restrictions may narrow it.
3. From **that Codex**, call `get_knowledge_map` with:

   ```json
   {"scope":{"tag_ids":[]},"max_chars":1000}
   ```

   This empty-scope read returns no personal content and calls no Persona model. `POST /api/studio/mcp-setup/probe` also generates a ready-to-send test message.
4. Read `GET /api/studio/mcp-setup` again. Match `client_read.workspace_id`, `tool` and fresh `received` time to the successful client call. A separate script, service self-check or old observation is not evidence that the target Codex works.

The observation records a successful MCP read, not a client's identity. Local configuration detection only covers the `CODEX_HOME` seen by Studio; project/remote configuration must also be checked in Codex. Configuration changes invalidate old observations.

## 4. Report the result

Report the workspace, server name, config/backup paths, and separately: **configuration saved**, **service check passed**, **Codex read succeeded**. If Codex needs a reload or user action, give the exact next step and leave that result pending.

To undo setup, remove only the added entry or restore its changed fields. Restore a whole backup only if no later changes would be lost. Keep Persona data and other integrations.

If the documented Studio endpoints are missing, the running version is older than this guide. Report the mismatch before upgrading; do not create a replacement workspace.

Reference: [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp).
