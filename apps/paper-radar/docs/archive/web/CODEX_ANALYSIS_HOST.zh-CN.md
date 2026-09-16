> 历史设计或验证记录。当前结构与运行方式以 [项目说明](../../../README.md) 为准；独立模型功能已移除。

# Codex 分析宿主使用说明

Paper Radar 本机服务现在支持在 **DSH** 和 **Codex** 之间选择分析宿主。这个选择适用于日报初筛、单篇分析、详细总结、个性化联系、复核、论文讨论和带工具的提示词实验。

## 使用前提

- Node.js 22.19 或更高版本。
- 本机已安装可用的 `codex` 命令行程序。
- Paper Radar 已完成构建，并通过 `npm run start:local` 启动本机服务。
- 需要个性化筛选时，Paper Radar 自身的 AI Persona 只读查询配置已可用。

## 首次启用 Codex

1. 打开 `http://127.0.0.1:4317/`，进入“设置 → 模型”。
2. 选择 **Codex** 标签，点击“登录 Codex”。
3. 在浏览器完成登录，回到 Paper Radar 等待页面显示“隔离检查通过”。
4. 配置“快速”和“深入”方案，或为六类任务选择自定义模型与思考强度。
5. 选择最大并行数（1–16）并保存。
6. 点击“用于后续新任务”。

切换只影响切换之后创建的任务。已经排队、正在运行或显式重试的任务保留其已冻结的宿主和模型配置。DSH 的账号、路由和运行方式不会被删除。

## Codex 隔离边界

Paper Radar 为 Codex 创建独立的运行空间，默认位于 `~/.local/share/paper-radar/codex/`。它不复制日常 Codex 的 `~/.codex` 配置、Hook、MCP、Apps 或任务历史；对 App Server 仍能枚举到的用户级和系统级 Skills，启动时逐一显式禁用并复查。

每次任务启动前都会失败关闭式地检查：

- Hook、Apps/远程插件、Shell、统一执行工具、Web Search、本地图像查看、记忆、持续目标、工具建议、子 Agent 和 Skills 必须关闭；Skills MCP 自动依赖安装也单独关闭。
- 不能存在可调用的 AI Persona MCP 或其他未授权 MCP。
- Codex 只能看到当前任务需要的 Paper Radar 工具，工具参数仍由 Paper Radar 验证。
- 运行期间如果意外触发 Hook、文件修改、命令执行、本地图像查看或 Web Search，本次任务会立即中断。

Codex 不直接读取 AI Persona。它仅能通过 Paper Radar 已有的只读研究工具，读取当前任务已固定 scope 和 revision 的必要内容。本版本不向 AI Persona 写入提案、反馈、讨论、阅读状态或任务笔记。

## 路由、并行与备用

- DSH 与 Codex 各自保存快速/深入方案、任务分配、思考强度和并行数。
- 并行数是宿主内同时运行的 Agent 上限，调低它不会取消已经开始的任务。
- 备用模型只在同一宿主内处理受限的平台错误。
- Codex 失败不会自动转到 DSH，DSH 失败也不会自动转到 Codex。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 显示未找到或无法启动 Codex | 在同一用户环境中确认 `codex` 命令可用，然后重启 Paper Radar。 |
| 显示需要登录 | 从 Paper Radar 模型设置重新发起登录；专用运行空间与日常 Codex 分开。 |
| 隔离检查失败 | 不要绕过。检查当前 Codex 版本是否仍支持相应配置和 App Server 接口。 |
| 不能启用 Codex | 只有连接状态和隔离检查都通过时才能切换。DSH 仍可继续使用。 |
| 旧任务仍由原宿主运行 | 这是预期行为；切换仅影响后续新任务。 |

## 本机存储

默认目录为：

```text
~/.local/share/paper-radar/
├── hosts/backend.json        # 当前默认宿主
├── dsh/                  # DSH 独立路由
├── codex/
│   ├── runtime-home/         # 专属 Codex 配置与认证
│   ├── routes.json           # Codex 模型和并行配置
│   ├── workspace/            # 只读 Agent 工作目录
│   └── tasks/                # 短期任务工具上下文
└── data/                     # Paper Radar 业务数据
```

`PAPER_RADAR_DATA_DIR` 改变模型配置基准目录，`PAPER_RADAR_STORAGE_DIR` 改变业务数据目录。这些目录只适合本机单用户服务，不应随静态站点发布。
