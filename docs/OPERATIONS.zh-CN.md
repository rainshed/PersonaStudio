# 运行与数据管理

[English](OPERATIONS.md) · [仓库首页](../README.zh-CN.md)

## 模型连接

AI 功能是可选的。打开「设置 → 模型」，依次安装组件、添加账号、完成认证、测试模型并保存默认值。

| 平台 | 支持的认证方式 |
| --- | --- |
| OpenAI API | API Key |
| ChatGPT / Codex | 浏览器或设备码账号登录 |
| Claude、Gemini、DeepSeek | API Key |
| OpenRouter | API Key 或账号登录 |
| Moonshot / Kimi 开放平台 | API Key |
| Kimi For Coding | 专用 Key 或账号登录 |
| 自定义兼容服务 | API Key，或明确设置为无需认证的本地服务 |

这只是应用提供的接入列表，不保证某个账号、地区、订阅或模型一定拥有提供方权限。成功测试只对应当时的连接版本和所选模型；修改连接或重新授权后，需要重新测试。

凭据加密保存在本机账号目录中。加密密钥也在本机，因此仍应保护该目录。安装运行组件不会读取或删除凭据；Demo 账号与真实工作区账号相互隔离。

需要查看详细安装输出时：

```sh
ai-persona models-install
ai-persona models-stop
```

## 工作区内容

所有真实工作区都应保存在应用安装目录之外。

| 位置 | 内容 |
| --- | --- |
| `<workspace>/persona-data/records` | 已生效的知识、课程、材料、偏好、标签、关系和依据 |
| `<workspace>/persona-data/sources` | 原始来源、提取表示与清单 |
| `<workspace>/persona-data/proposals` 和 `revisions` | 待审核候选与审核历史 |
| `<workspace>/persona-data/evaluations` | 反馈样例、固定测试集与评测结果 |
| `<workspace>/persona-data/generated` | 可重新生成的人类和 Agent 投影 |
| `<workspace>/persona-state` | 索引以及持久草稿、AI 会话、材料整理状态和提示词实验 |
| 外部学习目录 | 与工作区关联的对话学习队列和状态 |
| 模型与运行目录 | 共享凭据、可选运行组件和可重建的模型缓存 |

不要把整个 `persona-state` 当作可随意删除的缓存。标准备份包含工作区数据、状态和关联学习库，但不包含全局模型凭据。

## 备份、恢复与迁移

先完成运行中的任务，并停止所有写入者：

```sh
PERSONA_WORKSPACE="$HOME/PersonaWorkspaces/main"
ai-persona learning stop-worker --workspace "$PERSONA_WORKSPACE"
ai-persona stop --workspace "$PERSONA_WORKSPACE"

mkdir -p "$HOME/PersonaBackups"
ai-persona backup \
  --workspace "$PERSONA_WORKSPACE" \
  --output "$HOME/PersonaBackups/main.tar.gz"
```

每次使用新的备份文件名。备份包含私人正文、来源、草稿和历史，应保存在工作区之外，不能提交到仓库。

恢复必须使用新目录：

```sh
ai-persona restore "$HOME/PersonaBackups/main.tar.gz" \
  --workspace "$HOME/PersonaWorkspaces/restored"
ai-persona validate --workspace "$HOME/PersonaWorkspaces/restored"
ai-persona start --workspace "$HOME/PersonaWorkspaces/restored"
```

迁移同样复制到新目录，不修改原工作区：

```sh
ai-persona migrate \
  --from "$HOME/ExistingPersona" \
  --workspace "$HOME/PersonaWorkspaces/migrated"
ai-persona validate --workspace "$HOME/PersonaWorkspaces/migrated"
```

恢复或迁移后，先检查重要记录，再重新连接确实需要的接入和自动功能。

## 重新初始化内容

使用「设置 → 数据管理 → 清空内容，保留配置」预览工作区重置。它会清除 Persona 内容和处理历史，保留模型连接、登录授权、应用接入、语言、提示词和默认设置。备份可选且默认不勾选；不备份时，成功完成的清理无法撤销。

材料整理工作区还提供「清除本次提取结果」。输入来源继续保留，之后被编辑或被其他内容引用的记录会受到保护。两种操作都会先停止任务，要求最新预览和明确确认；写入失败时自动回滚。

## 更新或移除

再次运行安装命令即可更新。安装器会校验新版本、保留旧应用版本，并在冒烟检查通过后切换；不会移动工作区数据。

```sh
curl -fsSL https://github.com/rainshed/PersonaStudio/releases/latest/download/install.sh | sh
```

当前没有一键卸载命令。请先停止 Studio、学习后台、模型服务和远端隧道，只移除客户端中属于 AI Persona 的配置，再按安装位置删除应用版本。工作区、模型账号和缓存彼此独立，不会自动删除。

## 常见问题

首先运行：

```sh
ai-persona doctor
ai-persona status
ai-persona logs
```

| 现象 | 排查内容 |
| --- | --- |
| 没有配置工作区 | 运行 `ai-persona setup`、传入 `--workspace`，或使用 `--demo`。 |
| 浏览器显示旧版本 | 健康的旧进程可能被复用；完成任务后停止并重新启动。 |
| Studio 打开在其他端口 | 自动启动会选择空闲端口；用 `status` 查看实际地址。 |
| 显式端口被占用 | 选择其他端口或省略 `--port`；前台 `serve` 和网关端口保持固定。 |
| 缺少模型运行环境 | 安装 Node.js 22.19 或更新版本及 npm，运行 `models-install` 后重试。 |
| 认证或模型测试失败 | 核对具体账号、模型权限、地区、额度和提供方错误。 |
| 第一次语义搜索较慢 | 等待本地嵌入模型下载和工作区首次索引。 |
| 学习或偏好没有触发 | 检查来源范围、Hook 信任、独立功能开关、模型配置和后台状态。 |
| 远端页面返回 403 | 确认 `AI_PERSONA_PUBLIC_ORIGIN` 与外部协议、主机和端口完全一致。 |
| 备份或恢复被拒绝 | 停止写入者，选择新目标，并处理报告的安全检查。 |

日志可能包含私人路径和请求信息。只能分享必要的脱敏片段，不要上传完整工作区、模型目录或对话备份。
