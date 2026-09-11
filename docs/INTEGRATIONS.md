# Integrations / 集成说明

AI Persona remains the application name. PersonaStudio is the containing repository. The integrations below are optional and should point to an explicit workspace.

## MCP for local agents / 本地 MCP

The local MCP entry uses stdio. From the repository root:

```sh
uv run --locked --no-editable --project apps/ai-persona \
  ai-persona-mcp --workspace "$HOME/PersonaWorkspaces/main"
```

For an MCP client, configure `uv` as the executable and pass the same arguments. Use an absolute project path because clients may launch from another working directory. Replace both example paths below before saving:

```json
{
  "command": "uv",
  "args": [
    "run", "--locked", "--no-editable",
    "--project", "/path/to/PersonaStudio/apps/ai-persona",
    "ai-persona-mcp", "--workspace", "/path/to/your-workspace"
  ]
}
```

Clients differ in how this server entry is nested in their configuration. Keep their existing servers. Studio manages preferences, maintenance and human review separately.

The public local and remote MCP servers expose exactly six read-only tools:

| Tools | Purpose |
| --- | --- |
| `get_knowledge_map`, `search_knowledge`, `get_persona_records` | Discover and read scoped effective knowledge. |
| `list_source_files`, `search_source_content`, `read_source` | Read declared material sources and injected preference reference samples. |

Preferences are selected and injected by the separate Hook workflow. Preference maintenance, conversation ingestion, proposals, review status and incremental synchronization remain internal services; none are public MCP tools. Internal maintenance reuses the query definitions and adds its own preference queries. AI proposals still require human review in Studio.

Scope applies to knowledge, evidence and source access. Query results include revisions, coverage and continuation information. The server provides no write, preference activation or diagnostic tools.

Semantic retrieval runs a local embedding model. Its first use can download model files and take longer than a normal request. Set a sufficient client timeout. `AI_PERSONA_SEMANTIC_SEARCH=0` explicitly disables the semantic channel; text and graph retrieval remain available with the corresponding coverage report.

本地 MCP 使用 stdio，客户端应配置绝对项目路径和工作区路径。公共 MCP 仅提供上述 6 个只读工具，不提供偏好维护、对话学习或提案接口；知识、证据和来源都受范围约束。本地语义检索首次使用需要下载模型，降级状态会明确返回。

For assisted setup, use **Settings → App connections → Copy MCP setup instructions** and paste into Codex. The prompt includes the current workspace and the [MCP setup guide](../apps/ai-persona/src/ai_persona/static/guides/CODEX_MCP_SETUP.md).

在「设置 → 应用接入」复制 MCP 接入指令并粘贴到 Codex；指令包含当前工作区信息和接入指南链接。

## Codex learning and preference application / Codex 学习与偏好应用

Saving preferences requires neither a Hook nor MCP. Automatic use in daily Codex messages and conversation learning share the Codex Hook, but each feature has its own switch. Basic MCP queries require client configuration, independently of the Hook. **Settings → App connections** provides a workspace-specific MCP entry, a service self-check, and an empty-scope read test message. The self-check starts Studio’s server and checks the handshake and six-tool catalog without reading personal data. A separate successful MCP read records only the tool, timestamp, server host and workspace; it does not attest a named client’s identity. Configuration changes invalidate displayed observations. Neither check tests model-backed activation. Material extraction at `/extract` uses its own Codex runtime and does not require a daily-conversation Hook.

保存偏好不要求 Hook 或 MCP。日常自动应用偏好与对话学习共用 Codex Hook，但分别开启；普通 MCP 查询只要求客户端配置，不依赖 Hook。「设置 → 应用接入」提供当前工作区的 MCP 配置、服务自检和空范围查询测试消息。自检仅检查 Studio 服务的握手及 6 个工具；目标客户端实际查询后，页面显示工具、时间和工作区的调用记录，不证明指定客户端身份。配置变化使旧记录失效，两项检查均不代表偏好匹配已可用。「从材料提取知识」使用独立的 Codex 运行组件，无需安装日常对话 Hook。

Use **Settings → App connections** to select the Codex source, projects/sessions, and whether previous conversation context is available. Install and verify the integration through that page, then review the new Hook in the host application's trust workflow. Preserve unrelated Hooks and MCP settings.

Learning, source trust, model processing, and preference application are independent choices. Enable only the capabilities and scope you intend. A successful connection probe alone does not prove that a real Codex turn triggers the Hook; test from the actual client and inspect the corresponding Studio record.

The unified Hook supports both learning and preference application. AI-generated candidates still require review. The Demo does not install host Hooks or collect real sessions.

在「设置 → 应用接入」选择真实使用的 Codex 来源、项目或会话范围与前文策略，安装后还需在宿主应用中检查 Hook 信任状态。各项自动功能独立启用；请用真实客户端新发起一轮请求验证，连接探针不能代替实际触发。Demo 不安装宿主 Hook 或采集真实会话。

For assisted Hook setup, use **Settings → App connections → Copy Hook setup instructions**. The [Hook setup guide](../apps/ai-persona/src/ai_persona/static/guides/CODEX_HOOK_SETUP.md) covers scope, installation, trust and a real message test. Manual controls remain under **Manual setup & troubleshooting**.

在同一页面复制 Hook 接入指令，交给 Codex 完成安装并引导信任与真实消息验证。MCP 与 Hook 分别设置；手动配置位于折叠区。

Detailed behavior: [conversation learning](../apps/ai-persona/docs/AI_PERSONA_CONVERSATION_LEARNING_USAGE.zh-CN.md) and [preference application](../apps/ai-persona/docs/AI_PERSONA_PREFERENCE_ACTIVATION_USAGE.zh-CN.md).

## Remote Codex over SSH / SSH 远端 Codex

AI Persona can expose an authenticated HTTP MCP gateway through an SSH reverse tunnel. Data stays on the local Persona machine; the remote client and Hook access the tunnel endpoint.

From the repository root, using an existing SSH alias:

```sh
./scripts/ai-persona remote setup \
  --ssh-host my-server \
  --workspace "$HOME/PersonaWorkspaces/main"
./scripts/ai-persona remote start
./scripts/ai-persona remote status
```

`my-server` is an example SSH alias, not a server provided by this project. Setup changes the selected remote client's configuration and stores connection credentials locally on the relevant hosts. Read the [remote setup guide](../apps/ai-persona/docs/REMOTE_CODEX.zh-CN.md) before using it. The current installer targets POSIX environments, expects the documented remote Python/shell layout, and defaults to local gateway port 8766 and remote port 18766. Gateway ports do not change automatically; check their configured availability when setting up the tunnel.

You can leave an existing gateway or Studio running when opening the Demo. Without `--port`, local `setup` and `start` prefer 8766 for the Demo or 8765 for a real workspace and choose an available port when occupied; a healthy service for the same workspace is reused. Explicit `--port` conflicts are reported, and foreground `serve` retains fixed-port behavior.

Verify MCP from the real remote Codex process, including its host, container, `CODEX_HOME`, and session directory. A login node's loopback address may differ from the machine running Codex. For multiple hosts, custom environments, or persistent launchers, use the [detailed agent runbook](../apps/ai-persona/docs/REMOTE_CODEX_AGENT_RUNBOOK.zh-CN.md).

```sh
./scripts/ai-persona remote stop
```

远端接入保留令牌认证的 HTTP MCP、统一 Hook 与自动重连反向隧道。请先阅读远端指南，确认真正运行 Codex 的主机、网络与配置目录；示例别名需要替换，不提供公共服务器。网关端口按配置固定，不自动切换。已有网关或 Studio 运行时，可以直接用未指定 `--port` 的 `setup` 或 `start` 打开 Demo：首选端口被占用时会自动选择空闲端口，同工作区健康服务会复用。显式端口冲突仍报错，`serve` 保持固定端口。

## Browser access from another device / 其他设备访问网页

Keep the backend on loopback and configure a local HTTPS reverse proxy for your own devices. Set `AI_PERSONA_PUBLIC_ORIGIN` to the exact external scheme, hostname, and port before starting Studio. The application validates origins and remains single-user; this is not a public multi-user hosting mode.

For a Tailscale Serve example and validation steps, see the [remote browser guide](../apps/ai-persona/docs/REMOTE_ACCESS.zh-CN.md). Remote browser access is independent of remote Codex and SSH tunnels.

网页远端访问与 SSH 接入是两个独立功能。后端继续监听本机，由自己的 HTTPS 代理转发；`AI_PERSONA_PUBLIC_ORIGIN` 必须与实际入口完全一致。它仍然是单用户工作区。

## Prompt Workbench / 提示词工作台

The existing application can link from evaluation improvement references to a compatible **Prompt Workbench** service on `127.0.0.1:4318`. It checks the service identity before offering that integration. The service is **not included** in this repository, and there is no sibling-directory installation step to run here.

When available, the workbench can edit prompts, try actual stage inputs, compare versions, and activate or revert prompt versions through AI Persona's integration APIs. Persona storage, manual editing, review, model settings, and the built-in evaluation pages do not depend on the workbench process. A browser on another device cannot use the local machine's workbench via its own `localhost`; the remote Studio flow keeps that boundary explicit.

未来的 Promptbench 可能以同级应用加入，但本版没有该目录，也不提供未发布的安装链接。当前保留的是与单独运行的 Prompt Workbench 的接口和入口；工作台不可用时，本应用的知识、偏好、审核、模型设置和内置评测仍可使用。
