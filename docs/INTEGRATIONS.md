# Integrations

[简体中文](INTEGRATIONS.zh-CN.md) · [Repository home](../README.md)

Every integration is optional and must point to an explicit workspace. Installing AI Persona does not authorize conversation collection, model processing, or preference application.

## Local MCP

The release provides a stable stdio entry:

```sh
ai-persona-mcp --workspace "$HOME/PersonaWorkspaces/main"
```

MCP clients may not inherit the interactive shell's `PATH`. Use the absolute path reported by `command -v ai-persona-mcp` and preserve unrelated server entries:

```json
{
  "command": "/Users/you/.local/bin/ai-persona-mcp",
  "args": ["--workspace", "/path/to/your-workspace"]
}
```

The public local and remote servers expose exactly six read-only tools:

| Tools | Purpose |
| --- | --- |
| `get_knowledge_map`, `search_knowledge`, `get_persona_records` | Discover and read reviewed knowledge, courses, materials, relationships, and personal state. |
| `list_source_files`, `search_source_content`, `read_source` | Browse and read files declared by visible material sources. |

Queries enforce scope, return revision and coverage information, and never publish changes. Preference maintenance, activation, conversation ingestion, proposals, and review remain internal. Semantic search uses a local multilingual embedding model; its first use may download model files. Setting `AI_PERSONA_SEMANTIC_SEARCH=0` disables only the semantic channel.

For assisted configuration, open **Settings → App connections → Copy MCP setup instructions** and paste the prompt into Codex. It includes the current workspace and the bundled [MCP setup guide](../apps/ai-persona/src/ai_persona/static/guides/CODEX_MCP_SETUP.md). The service self-check verifies the server and six-tool catalog without reading personal records; a separate real client query is still required.

## Codex Hook

One `UserPromptSubmit` Hook supports two independent features:

- **Preference application** selects reviewed global and contextual preferences for the current request.
- **Conversation learning** queues in-scope user messages for background analysis and creates reviewable candidates.

Configure a Codex source in **Settings → App connections**:

1. Choose specific projects or sessions, or explicitly select all local Codex sessions.
2. Decide whether bounded previous conversation context may be read.
3. Install or merge the generated Hook without replacing unrelated Hooks.
4. Review and trust the new or changed Hook in Codex.
5. Send the generated test message from a real in-scope Codex session.
6. Enable preference application or learning separately under **Automatic features**.

Source trust, collection, model processing, learning, preference application, and daily budgets are separate controls. A connection probe does not prove that the real host loaded the Hook. Configuration changes invalidate earlier verification. The Demo does not install Hooks or collect real sessions.

Use **Copy Hook setup instructions** for assisted installation. The bundled [Hook setup guide](../apps/ai-persona/src/ai_persona/static/guides/CODEX_HOOK_SETUP.md) covers merge, trust, and delivery verification.

## Remote Codex over SSH

AI Persona can expose an authenticated HTTP MCP gateway through an SSH reverse tunnel. Persona data stays on the local machine; the remote client and Hook reach the gateway through the tunnel.

Using an existing SSH alias:

```sh
ai-persona remote setup \
  --ssh-host my-server \
  --workspace "$HOME/PersonaWorkspaces/main"
ai-persona remote start
ai-persona remote status
```

The example alias must be replaced. The default local gateway port is 8766 and the remote port is 18766; gateway ports are fixed and must be checked before setup. Shared home directories, containers, login/compute-node boundaries, nondefault interpreters, and custom service managers require environment-specific validation.

Verify from the actual remote Codex process:

1. Discover the six MCP tools and perform a read.
2. Send a new message and confirm the Hook event in the local Studio.
3. If enabled, verify preference delivery and learning independently.
4. Confirm behavior after a tunnel reconnect.

A health check or manual client call proves only that one layer works. The loopback address of a login node may not be the loopback address visible inside the real Codex container or compute node.

```sh
ai-persona remote stop
ai-persona remote status
```

Stopping the tunnel does not remove remote client configuration. When uninstalling, remove only entries that belong to AI Persona.

## Browser access from another device

Keep Studio bound to loopback and place a private HTTPS reverse proxy in front of it. Set `AI_PERSONA_PUBLIC_ORIGIN` to the exact external scheme, hostname, and port before starting Studio:

```sh
AI_PERSONA_PUBLIC_ORIGIN='https://my-device.example.ts.net:8443' \
  ai-persona start --no-open --port 8765
```

For example, on a machine already configured for Tailscale:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8765
tailscale serve status
```

Stop only this forwarding rule when finished:

```sh
tailscale serve --https=8443 off
```

The external address is not supplied by this project, and access follows the proxy or tailnet policy. A device that can reach the authorized Studio origin can operate the single-user workspace. This is not public multi-user hosting. Remote browser access is independent of the SSH/Codex tunnel.

## Prompt Workbench

Evaluation improvement links can use a compatible Prompt Workbench service, normally at `127.0.0.1:4318`. That application is not included in this repository. AI Persona storage, manual editing, model settings, review, and built-in evaluations continue to work without it. On another device, `localhost` refers to that device rather than the computer running Studio.
