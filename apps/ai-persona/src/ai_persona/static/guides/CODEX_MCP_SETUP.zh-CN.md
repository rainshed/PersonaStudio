# 让 Codex 帮你配置 PersonaStudio MCP

把本文件交给你日常使用的 Codex，并发送：

> 请按这份文档帮我配置 PersonaStudio MCP，连接我正在使用的真实工作区。检查实际 Codex 环境，备份并保留已有配置，避免重复添加。完成后分别运行服务自检，并从目标 Codex 执行只读查询，核对工作区和最近查询记录。沿用我的工具权限设置，暂不安装 Hook 或开启其他自动功能。

Codex 可以完成环境检查、配置和工具调用验证。当前会话无法加载新工具时，它会告诉你如何重新加载，以及需要发送的验证消息。配置写入成功后，还要确认实际客户端能够调用。

本文默认配置与 PersonaStudio 位于同一台 macOS 或 Linux 主机的 Codex，使用本地 stdio 连接。SSH、容器和 WSL 需要先确认实际运行环境；其他 MCP 客户端使用同一个服务入口，但配置格式应遵循该客户端说明。

## 给执行任务的 Codex

用户把本文作为配置任务交给你后，请直接完成以下流程。优先识别已有环境和选择；只有工作区、客户端或配置范围存在无法判断的歧义时才询问，不反复确认已授权的操作。

公共 MCP 仅提供 6 个知识与来源只读工具：get_knowledge_map、search_knowledge、get_persona_records、list_source_files、search_source_content、read_source。偏好触发、学习和维护由内部流程负责。它不要求安装 Hook；日常自动应用偏好、对话学习各自启用，不属于本次配置任务。普通接入检查不需要模型账号。

### 1. 识别工作区、服务和目标客户端

1. 从用户提供的 Studio 页面或实际运行服务识别地址与工作区。源码安装的入口是仓库中的 `scripts/ai-persona`，其他安装方式使用实际的 `ai-persona` 程序。先读取 `--help` 和 `status`；需要启动已确认的工作区时使用 `start --workspace <绝对路径> --no-open`。不要新建工作区或默认连接 Demo。
2. 用实际地址访问 `GET /healthz`，确认 `ok: true`、`demo: false`，记录 `workspace_id`。核对服务启动参数和用户工作区。不要假设端口一定是 8765，也不要把当前默认工作区当成正在运行的工作区。
3. 确认目标 Codex 的主机、启动方式、版本、有效 `CODEX_HOME` 及项目。默认配置候选为 `~/.codex/config.toml`；自定义配置目录和项目 `.codex/config.toml` 也要检查。安装任务运行的终端环境不一定等于用户日常 Codex 的环境。
4. 读取 `GET /api/studio/mcp-setup`，获取当前工作区生成的 `config`（TOML 字符串）。这是 MCP 的程序和参数，不是 Studio 网页的 URL。**本地连接选 STDIO，不把 Studio 地址填写为 HTTP MCP 地址。**

按 [Codex 官方 MCP 说明](https://learn.chatgpt.com/docs/extend/mcp)，用户配置与受信任项目的配置都可以定义 MCP。沿用用户已有配置范围；新配置默认写入目标 Codex 的用户配置。用户要求仅当前项目时，使用该项目配置。不要改写其他客户端或其他主机的配置。

远端 Codex 无法直接启动本机的 Python 或访问本机数据目录。此时查阅该版本仓库的 `apps/ai-persona/docs/REMOTE_CODEX_AGENT_RUNBOOK.zh-CN.md`，明确网关、认证和网络部署；不要为方便连接开放无认证公网服务。只有下载文档时，先找到用户安装版本对应的远端指南。

### 2. 检查并备份已有配置

用 TOML 解析器读取配置，只记录与本次修改相关的结构，不输出完整配置或凭据。确认配置文件存在性、权限和符号链接的真实目标；已有无效配置先定位错误，不覆盖成空文件。

- 有条目已连接同一工作区且启动参数可用：复用该条目，不重复添加。
- `ai_persona` 名称已被其他服务或工作区占用：保留它，为新工作区使用可区分的名称。
- 同一条目需要更新路径：保留原有环境、超时和权限策略。同步移除白名单中的已退役工具；保留用户对剩余六个工具的限制，不自动扩大权限。
- 条目被用户禁用：核对用户当前是否要求重新启用；不能把“查看配置”当成启用授权。

修改前把原文件完整备份到用户本地，记录路径，备份仅本人可读。若文件还不存在，记录这个事实。后续保存前确认它没有被其他程序修改；发生变化时重新合并。保留无关设置、其他 MCP 服务、Hook 和注释。

### 3. 写入本工作区的 MCP 配置

解析 Studio 返回的 `config`，核对其中的绝对 Python 路径、`--data`、`--state` 是否存在并指向目标工作区。保留生成配置里的应用包路径 `env.PYTHONPATH`，并合并该连接原有的其他环境项。解释器必须能够加载当前版本 `ai_persona.mcp_server`，不依赖终端的当前目录、临时环境或一段未保存的启动脚本。

当前生成的配置结构如下。下面仅展示结构，执行时使用 Studio 返回的真实值，不能照抄示例路径：

```toml
[mcp_servers.ai_persona]
command = "/absolute/path/to/persona-python"
args = ["-m", "ai_persona.mcp_server", "--data", "/absolute/path/to/persona-data", "--state", "/absolute/path/to/persona-state"]
enabled_tools = ["get_knowledge_map", "search_knowledge", "get_persona_records", "list_source_files", "search_source_content", "read_source"]

[mcp_servers.ai_persona.env]
PYTHONPATH = "/absolute/path/to/application/package-root"
```

新增用户级条目时，可以使用目标 Codex 的 `mcp add`。先读取实际版本的 `codex mcp --help` 和 `codex mcp add --help`，确保操作的是正确配置目录。命令结构为：

```sh
codex mcp add ai_persona -- "/absolute/path/to/persona-python" -m ai_persona.mcp_server --data "/absolute/path/to/persona-data" --state "/absolute/path/to/persona-state"
```

名称、程序和路径均替换为上一步确认的值。使用 `mcp add` 新增后，还需从 Studio 配置片段合并 `enabled_tools` 和 `env.PYTHONPATH`，不要遗漏应用包路径。程序调用优先传参数数组，使用 Shell 时正确引用含空格或特殊字符的路径。已有同名条目、项目级配置或需要保留条目额外字段时，使用保留格式的定点 TOML 编辑，不用 `mcp add` 覆盖整个已有条目。

若采用源码项目的 `uv` 启动方式，则使用该版本集成指南中的 `uv run --locked --no-editable --project <应用绝对路径> ai-persona-mcp --workspace <工作区绝对路径>`，并确认 Hook／客户端进程也能找到该 `uv` 可执行文件。不要把工作区选择留给默认值。

写入后重新解析 TOML，检查差异和程序可执行性。可使用 `codex mcp list` 或 `codex mcp get <实际服务名>` 检查已写入的配置；这些检查还不能证明当前客户端已加载服务。不得通过放开全部工具权限来解决连接失败。

### 4. 让实际 Codex 加载 MCP

在目标客户端的 MCP 管理入口重新加载该服务；CLI 可用 `/mcp` 查看当前连接。当前会话未发现新工具时，按该版本客户端的方式重新打开会话或重新加载。保留正在进行的任务；需要用户操作时明确告诉他入口和下一步。

本地 stdio 服务由客户端启动，无需额外启动 HTTP 网关，也无需为它执行 OAuth 登录。检查 Python 路径、包版本、参数和目录权限；如果提示不认识 `--data` 或 `--state`，说明启动的包版本与 Studio 生成配置不一致，先确认并修复版本或使用该版本支持的 `--workspace` 入口。不要迁移或重建数据来绕过错误。

### 5. 分别检查服务和实际客户端

| 请求 | 用途 |
| --- | --- |
| `GET /api/studio/mcp-setup` | 获取配置、`service_check` 自检结果和 `client_read` 最近成功查询 |
| `POST /api/studio/mcp-setup/diagnose`，JSON 为 `{}` | 用 Studio 的解释器启动服务，完成握手与六工具清单检查；不调用查询工具或模型 |
| `POST /api/studio/mcp-setup/probe`，JSON 为 `{}` | 生成使用现有 `get_knowledge_map` 的空范围查询消息 |

写请求发往已确认的 Studio，使用：

```text
Content-Type: application/json
X-AI-Persona: 1
X-Persona-Workspace: <第 1 步记录的 workspace_id>
```

这些头不代替远程身份认证。工作区切换或访问被拒绝时，检查目标地址与配置，不放宽访问控制。

1. 运行服务自检，检查 `ok: true` 和工具列表恰好为上述 6 项。自检只验证 Studio 的服务程序，不验证用户客户端的可执行路径、配置或网络。
2. 在目标客户端重新加载 MCP，确认仅有这 6 个只读工具。执行测试消息中的 `get_knowledge_map`，参数为 `{"scope":{"tag_ids":[]},"max_chars":1000}`。空范围返回空知识内容，不读取个人正文或调用模型。
3. 当前任务就是目标客户端且工具已可用时，直接调用；否则将消息交给用户在重新加载后的目标会话执行。不要另启动脚本或直接调用内部函数来代替真实客户端测试。
4. 确认工具返回成功，再读取 Studio 状态，核对 `client_read.workspace_id`、`tool` 和 `received`。内部业务查询、握手、工具枚举、失败调用和服务自检都不会生成该记录。

最近查询记录只保存工作区、服务主机、工具名和时间，不保存参数、正文或来源内容。它证明服务处理过一次成功 MCP 查询，不证明指定客户端身份；多个客户端共用同一工作区时，需要结合目标客户端中的真实调用结果判断。不要把其他客户端的调用或旧记录当成本次测试。

配置变化后旧记录不再显示；已经运行的旧服务进程不能验证新配置。当前配置检测只读取 Studio 所见的 `CODEX_HOME/config.toml`，不能完整检查另一主机、项目配置或远端客户端。应分别报告检测范围、自检结果和实际调用结果。

偏好自动注入和对话学习通过独立 Hook 流程运行；普通 MCP 自检或查询成功不证明这些功能已启用。

### 6. 交付与撤销

报告实际工作区、目标客户端与配置目录、服务名、修改与备份位置，以及三个独立结果：配置已写入、客户端已加载、只读查询成功。分别附上自检状态、工作区 ID 和最近查询时间。需要重新加载或等待用户发验证消息时，明确下一步，不声称已经全部完成。

本次不自动安装 Hook、开启对话学习、调用模型测试或生成修改提案。用户另行要求这些功能时按其选择执行；公共 MCP 不提供提案、审核、学习或偏好维护工具。

临时停用时在客户端禁用这个服务。需要撤销时，只移除本次添加的条目或恢复本次修改的字段；只有确认安装后没有其他修改，才能恢复完整备份。保留其他 MCP、Hook、Persona 数据和备份。
