# 让 Codex 帮你安装 PersonaStudio Hook

把本文件交给你日常使用的 Codex，并发送：

> 请按这份文档帮我安装 PersonaStudio Hook。优先识别我正在使用的 Studio 工作区和 Codex 环境，保留已有配置。新连接默认只接入当前项目、仅使用本次输入；自动偏好和对话学习沿用已有选择，未选择的功能先保持关闭。完成安装检查，再引导我完成 Codex 的信任和真实消息验证。

Codex 可以完成环境检查、配置合并、备份和安装检查。遇到 Hook 信任审查时，按 Codex 提示操作；接着在要接入的会话中发送生成的测试消息。不要把“配置安装完成”当成“实际使用已经验证”。

本指南适用于 PersonaStudio 与 Codex 在同一台 macOS 或 Linux 主机上的接入。SSH、容器或其他机器上的 Codex 需要在实际运行环境中部署，不能把本机路径直接复制过去。原生 Windows 不适用此安装器；WSL 按独立 Linux 环境判断。

## 给执行任务的 Codex

用户把本文作为安装任务交给你后，请按以下步骤执行，不要只复述说明。优先复用 Studio 的现有安装接口；只有目标工作区、Codex 实例或接收范围无法确定时，才询问缺少的信息。沿用用户已明确的选择，不重复确认。

本文只负责 Hook 接入。保存知识和偏好不需要 Hook；日常自动应用偏好与对话学习共用这一个 Hook，并各自开启。MCP 查询独立配置，“从材料提取知识”使用独立 Codex 运行组件。这些功能不应被一并默认安装或开启。

### 1. 确认实际工作区和 Codex 环境

1. 从用户提供的 Studio 页面、运行中的服务或项目启动入口识别 Studio。源码安装使用仓库中的 `scripts/ai-persona`，已安装版本使用实际的 `ai-persona` 可执行文件。先读取 `--help` 和 `status`；需要启动时，用 `start --workspace <工作区绝对路径> --no-open`。不要为了安装 Hook 创建新的 Persona 或使用 Demo。
2. 不要假定 Studio 在 8765 端口。读取启动输出中的 `url`，访问 `GET /healthz`，确认 `ok: true`、`demo: false`。记录 `workspace_id`，核对服务启动参数中的工作区与用户目标一致。默认工作区不一定是当前正在运行的工作区。
3. 识别用户真正使用的 Codex：桌面应用、CLI 或 IDE，以及实际主机、项目目录、版本、有效 `CODEX_HOME`。`~/.codex` 只是默认候选；Studio 检测到的环境不一定与 Codex 相同。不要打印完整进程环境、认证文件或会话正文。
4. 检查该 Codex 的 `hooks.json`、`config.toml` 和相关项目配置层。只检查 Hook 相关结构、路径、权限、符号链接和是否禁用。已有 Persona Hook 可能来自另一个工作区、来源或旧路径，不能仅凭显示名称认定为当前连接。
5. 若是远端或容器，先明确网络与运行环境。仓库的 `apps/ai-persona/docs/REMOTE_CODEX_AGENT_RUNBOOK.zh-CN.md` 是远端执行指南；若只有下载的本文件，请先找到用户使用版本对应的指南，不在本机代装远端 Hook。

记录安装前的连接、自动偏好设置、学习设置和后台处理状态，供最后核对。部署参数和日志留在用户本地，不写入公共仓库。

### 2. 复用或创建来源连接

优先复用当前工作区中与目标 Codex 主机、配置目录及接收范围匹配的来源。名称相同不是充分依据；已有多个候选时先明确目标。不要为一次重复安装创建新连接。

新连接采用用户已选择的项目／会话范围。按照开头任务说明执行时，默认仅当前项目、仅本次输入、不信任未验证的用户消息；没有项目的会话需要用户指定范围，不能悄悄改为所有会话。若用户要求会话前文，仅授权该实例确实可读取的会话目录，不扫描历史会话。

注意：学习开关是工作区级的。如果工作区已开启学习，新建并启用来源可能使新范围开始被学习。此时先核对用户是否已授权这个范围；没有授权时保持新连接 `enabled: false`，安装可以继续，但报告“来源未启用，接入验证未完成”。不要为了验证关闭其他来源正在使用的全局功能。

Studio 的交互入口为 **设置 → 应用接入 → 接入 Codex**。可直接使用同一组本机接口：

| 请求 | 用途 |
| --- | --- |
| `GET /api/learning/v1/config` | 读取完整来源列表、学习设置和后台状态 |
| `GET /api/preferences/application/config` | 读取自动偏好设置 |
| `GET /api/learning/v1/codex/environment?home=<URL 编码的实际 CODEX_HOME>` | 检查指定的本机 Codex 目录 |
| `GET /api/learning/v1/connections/<URL 编码的连接 ID>/setup` | 读取该来源的环境、配置预览、版本和验证状态 |
| `POST /api/learning/v1/codex/connections` | 保存带版本检查的来源配置 |

所有请求发往已确认的 Studio 地址。写请求必须使用 JSON，并携带：

```text
Content-Type: application/json
X-AI-Persona: 1
X-Persona-Workspace: <第 1 步记录的 workspace_id>
```

这些头不代替远程身份认证。若访问被拒绝，检查实际地址、主机和配置，不放宽访问控制或改成公网监听。发现工作区切换时停止当前写入，重新确认目标。

保存来源的请求结构如下，尖括号值都要替换为探测结果；示例默认禁用来源，按用户已授权的接收选择设置 `enabled`：

```json
{
  "expected_revision": "",
  "connection": {
    "id": "<新生成且保存后继续复用的连接 ID>",
    "name": "我的 Codex",
    "adapter": "codex",
    "enabled": false,
    "scope_mode": "restricted",
    "trust_user_messages": false,
    "allowed_scopes": ["<新生成的范围 ID>"],
    "allowed_conversations": [],
    "adapter_config": {
      "codex_home": "<实际 Codex 配置目录的绝对路径>",
      "project_scopes": {
        "<当前项目的绝对路径>": "<与 allowed_scopes 相同的范围 ID>"
      },
      "transcript_roots": []
    },
    "capabilities": {
      "stable_event_identity": false,
      "message_revisions": false,
      "verified_human_origin": false,
      "context_snapshot": true
    }
  }
}
```

新增来源使用空字符串 `expected_revision`。更新来源时，先读取该来源的 setup，保留完整 `connection` 中未修改的字段，使用返回的 `connection_revision`。不要用精简示例覆盖已有设置。冲突时重新读取并检查差异，不绕过版本检查。

### 3. 安装统一 Hook

1. 获取该来源的 setup，核对 `environment.codex_home`、`installation.path` 与目标一致，检查 `installation.snippet` 中的 Python、包路径、数据、状态、队列目录和连接 ID。Hook 使用绝对路径，安装后的运行环境必须持续存在，不使用即将清理的临时目录。
2. `installation.installed: true` 表示当前配置已匹配，可跳过写入。否则，必须先确认 `can_install: true`；若为 false，按返回的 `error` 修复根因。符号链接、无效 JSON、远端路径或不受支持的现有结构，不通过覆盖整个文件解决。
3. 用最新预览中的 `installation.revision` 调用：

   ```text
   POST /api/learning/v1/connections/<URL 编码的连接 ID>/setup/install
   {"revision": "<最新 installation.revision>"}
   ```

4. 检查返回的 `installation.installed`、`changed` 和 `backup`，保存实际备份路径。安装器会合并当前连接的统一 `UserPromptSubmit` Hook、保留其他条目，并在修改已有文件前备份。无需分别安装“学习 Hook”和“偏好 Hook”。
5. 重新读取 setup，比较安装前后配置：无重复安装、无无关配置丢失，自动功能设置保持原有选择。不要通过直接修改 SQLite、调用内部函数或手写另一套 Hook 来绕过安装器。

若接口不存在，确认 Studio 是否仍运行旧版本；检查该用户安装版本的指南。不要在未确认目标的情况下升级、更换工作区或重建数据。需要重启 Studio 时，先确保当前没有正在处理的任务。

### 4. 让目标 Codex 加载并信任 Hook

Codex 会检查新建或修改过的 Hook 的信任状态。CLI 可通过 `/hooks` 审查；其他客户端使用其 Hook 审查入口。只审查本次安装到目标文件的 Persona 命令，不批量信任无关 Hook。若尚未加载新配置，重新打开目标会话后检查。

检查是否有禁用配置或管理策略限制。用户明确禁用了 Hook 时，不自行改变其选择；不要编辑信任数据库或绕过管理策略。需要用户操作时，给出具体文件、命令用途和下一步，不笼统要求“自行配置”。

Codex 会加载多个配置层的 Hook，同层的 JSON 与内联 TOML 也可能同时生效。因此还需检查项目内或内联配置中的重复 Persona 命令。已有重复时先明确归属，不删除其他工作区或其他工具的 Hook。上述配置位置、信任和合并行为依据 [Codex 官方 Hook 说明](https://learn.chatgpt.com/docs/hooks)；执行时以用户所用版本为准。

### 5. 用真实 Codex 消息验证

1. 在来源已按用户选择启用、安装检查通过之后，生成新探针：

   ```text
   POST /api/learning/v1/connections/<URL 编码的连接 ID>/setup/probe
   {}
   ```

2. 把返回的 `probe.message` 原样交给用户，请其在目标主机、目标 Codex 配置和允许的项目／会话中发送。消息 15 分钟内有效；不要手动向 Hook 输入伪造事件、直接运行 Hook 命令或调用探针处理函数来冒充实际触发。
3. 用户发送后重新读取 setup。成功条件为 `probe.status: received`、`probe.scope_ok: true`，且前文状态符合选择：仅本次输入为 `disabled`；允许会话前文为 `readable`。来源配置变化会使之前的验证失效，应生成新探针。
4. 未收到时，依次核对实际主机与 `CODEX_HOME`、Hook 是否加载及信任、接收范围、命令路径与权限。会话前文不可读取时修复目录或让用户选择仅本次输入，不擅自扩大目录权限。不要高频轮询；用户尚未发消息时，明确停在等待真实验证这一步。

该探针不会调用 Persona 的学习或偏好模型，也不会保存测试消息正文；Codex 本身仍会正常处理这轮请求。探针成功证明本次 Hook 接入，不代表模型、自动偏好或学习处理也已验证。

### 6. 按用户选择启用功能并交付结果

仅要求安装 Hook 时，在安装、信任和接入验证完成后即可交付；未启用的自动功能继续保持关闭。用户另有明确选择时，在 **设置 → 自动功能** 分别设置：

- **自动应用偏好**：开启功能并选择本连接；需要场景判定时配置相应模型。用真实请求检查对应的偏好应用记录。
- **对话学习**：开启接收与学习，按用户选择设置来源信任、模型调用和预算，并启动后台处理。用真实新消息检查学习记录，候选内容仍由用户审核。不要回扫旧对话或自动批准候选。

最后用简短报告列出工作区、Codex 配置目录、来源和接收范围、安装结果、备份位置、信任状态、探针时间及结果，以及两项自动功能各自是否启用。只报告已得到证据的状态；尚需用户信任或发消息时，明确下一步。不要把模型密钥、会话正文或完整私有配置放入报告。

### 停用与恢复

临时停用时，在 **设置 → 应用接入** 禁用这个来源，或在 Codex 的 Hook 管理入口禁用对应命令。不要为了停用这一连接关闭所有 Hook。

需要撤销文件安装时，先对比当前文件与本次备份。仅当安装后没有其他改动时恢复原文件；否则只移除本次连接的命令并保留新增条目。安装前没有文件时，也不能直接删除后来已加入其他 Hook 的整个文件。不要删除 Persona 数据、其他来源、MCP 设置或备份。
