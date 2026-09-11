# AI Persona

[English](README.md) · [PersonaStudio](../../README.zh-CN.md)

本地优先、文件优先的个人知识与偏好工作区。你可以浏览知识图谱、阅读原始材料、维护可复用偏好、审核 AI 提议，并通过 MCP 向 Agent 提供范围受限的访问。

## 从本目录启动

先安装 [uv](https://docs.astral.sh/uv/getting-started/installation/)，然后使用仓库启动器：

```sh
../../scripts/ai-persona setup
```

也可以先体验虚构 Demo：

```sh
../../scripts/ai-persona start --demo
../../scripts/ai-persona doctor --demo
```

启动器自动使用本应用的锁文件和普通 Python 安装方式。Python 要求 3.12 或更新版本。面向 macOS、Linux；暂不支持原生 Windows，WSL 需要在实际环境单独验证。

AI 模型功能可选。「设置 → 模型」会检查环境，引导安装组件、接入账号、认证、测试并保存。缺少 Node.js 时提供安装入口；安装 Node.js 22.19 或更新版本及 npm 后，可直接在页面安装模型组件，也可以使用 `../../scripts/ai-persona models-install`。模型运行依赖位于 Python 包目录外；浏览和人工维护无需模型账号。

## 材料整理与知识图

「从材料提取知识」支持多篇 arXiv 和多个 Markdown、PDF、TXT 文件。Codex 按章节读取、合并知识与关系，再生成待审核提案；可修改提取规则、继续检查点及审核成功部分。复用本机 Codex 登录，或在页面连接 ChatGPT / OpenAI API key；无需日常对话 Hook。详见[使用说明与当前边界](docs/AI_PERSONA_EXTRACTION_USAGE.zh-CN.md)。

## 保留的能力

- 知识、课程、材料、原文、证据、关系与图谱导航。
- 全局及场景偏好、样例资源、人工编辑、归档与历史。
- 支持参考依据、多轮候选和人工审核的 AI 维护助手。
- 统一反馈审核工作台、个人测试样例、隔离评测和改进参考。
- 模型设置、任务路由、支持的提供方认证与可选备用模型。
- Codex Hook、范围受限的对话学习、偏好应用、本地 stdio MCP，以及通过 SSH 接入的认证 HTTP MCP。
- 中英文界面、响应式页面、已有路由，以及 `ai-persona` / `ai-persona-mcp` 命令名称。

人工保存立即生效并记录历史；AI 提议先进入待审核区；公共 MCP 仅提供 6 个知识与来源只读工具。Demo 使用内置虚构模板的独立副本。

完整页面与行为见[功能兼容矩阵](../../docs/FEATURE_PARITY.md)。Prompt Workbench 保留为**外部集成**，本仓库不包含工作台应用。

## 数据独立保存

工作区应放在仓库外。正式记录位于可直接阅读的 `persona-data` 文件中；`persona-state` 也包含持久草稿与历史，不能全部当作可丢弃缓存。旧工作区可以直接打开，也可以迁移为新目录中的独立副本，详见[数据管理](../../docs/DATA_MANAGEMENT.md)。

## 文档

- [上手指南](../../docs/GETTING_STARTED.zh-CN.md)
- [备份、恢复、迁移与更新](../../docs/DATA_MANAGEMENT.md)
- [MCP、Codex、远端访问与工作台](../../docs/INTEGRATIONS.md)
- [常见问题](../../docs/TROUBLESHOOTING.md)
- [详细使用说明与设计参考](docs/README.md)
- [Demo 使用说明](examples/demo-persona/README.md)
- [贡献指南](../../CONTRIBUTING.md) · [安全说明](../../SECURITY.md) · [许可证](../../LICENSE)

当前应用面向单用户，已包含语义检索与远端 HTTP MCP 网关；原生 Windows、公开多用户部署及内置提示词工作台不属于本版范围。
