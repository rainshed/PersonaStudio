# Paper Radar

本机运行的论文研究应用：读取 arXiv 公告与正文，按用户选择的 AI Persona 知识范围筛选论文，生成报告，并通过用户反馈评估推荐效果。

分析宿主仅支持 **Codex** 和 **DSH（DeepSeek Harness）**。模型目录、模型调用和认证由宿主管理。Paper Radar 管理业务任务、知识范围、提示词、报告、反馈与本机数据，不再提供独立模型连接、平台账号、API Key 或直接供应商调用功能。

## 项目结构

```text
paper-radar/
  README.md
  docs/                     # 当前架构、开发说明；archive/ 保存历史记录
  scripts/                  # 开发安装与检查
  components.json           # 应用、协议、插件的本机安装兼容清单
  web/                      # 完整应用：网页与本机业务服务
    app/
    components/
    lib/                    # 应用辅助代码与前后端共享定义
      contracts/
      host-settings.ts
      host-models.ts
    server/
      index.mjs
      analyses/ daily/ discussions/ evaluations/ prompts/
      persona/ storage/ notifications/ tasks/ agents/
      hosts/
        service.mjs         # 按任务冻结设置选择宿主
        execution.mjs       # 执行能力与宿主快照检查
        transport.mjs       # 应用侧传输
        codex/
        dsh/
      integrations/dsh/     # DSH 对话发起的业务操作
    tests/
  plugins/dsh/              # 加载进 DSH 的插件，独立安装
  packages/host-contract/   # 共享通信协议与结果结构
  work/                     # 本机实验输出，不纳入 Git
```

本应用位于 `PersonaStudio/apps/paper-radar/`，由 PersonaStudio 仓库统一管理；内部目录不建立独立 Git。
`web/components.json` 是界面组件工具配置，与根目录的安装兼容清单用途不同。

## 安装与运行

需要 Node.js 22.19 或更新版本及 uv。在 PersonaStudio 仓库根目录执行：

```sh
npm run setup:radar
npm start
```

普通启动直接引导连接 AI Persona、创建订阅，再配置 Codex 或 DSH 生成报告。已有研究记录的用户直接进入工作台。默认端口为 4317，被占用时自动选择可用端口。

- [本机使用、数据维护与验收](../../docs/PAPER_RADAR.zh-CN.md)
- [English guide](../../docs/PAPER_RADAR.md)

本轮仅交付本机测试版本，没有制作或发布统一安装包。开发者仍可在本目录使用 `node scripts/setup.mjs --verify`；完整跨应用验证从 PersonaStudio 根目录运行 `npm run check:radar`。

- [架构与模块边界](docs/architecture.md)
- [开发、验证与升级](docs/development.md)
- [提示词设置与模型输入](docs/prompt-settings.zh-CN.md)
- [Persona 查询能力与范围](docs/persona-queries.zh-CN.md)
- [DSH 插件安装](plugins/dsh/README.md)
- [Codex 接入的详细设计记录](docs/archive/web/CODEX_ANALYSIS_HOST.zh-CN.md)
- [历史产品需求](docs/archive/design/PAPER_RADAR_REQUIREMENTS.zh-CN.md)
- [AI Persona](../ai-persona/README.md)
- 提示词在应用“设置 → 提示词”中管理；通过“评测与反馈”创建测试集并比较实验配置。

## 功能与数据

支持单篇自主分析、按订阅生成日报、来源更新检查与自动调度、关注作者论文、按需详细报告、显式反馈和评测。无来源更新时不创建模型任务。

在“关注作者”中选择订阅并添加完整姓名：姓名相同且论文属于该订阅当前所选的任一 subject，就收入作者列表，不受 Persona 推荐结果影响。匹配忽略大小写和多余空格，缩写与全名分别添加，不进行作者身份消歧。名单保存于本机订阅中；取消关注或修改 subject 后，列表按当前设置重新匹配。

作者列表读取本机已存档的 arXiv 分类公告；“检查最新论文”读取当前官方公告，不调用模型，也不要求 Persona 连接。既有日报与自动来源检查抓取的公告会同时进入匹配范围。跨分类重复论文合并为一条并保留匹配到的最新版本；历史覆盖限于已存档公告，不表示完整作者发表史。日报另有“关注作者”筛选页签，可查看当前批次内的匹配论文。

论文讨论功能已移除，包括站内提问、外部应用跳转和段落讨论。原有讨论数据保留在本机数据库中，应用不再提供讨论入口或启动讨论任务。阅读页保留 arXiv 原文链接。

默认业务数据保存在 `~/.local/share/paper-radar/data/`，宿主偏好保存在相邻目录。本轮目录整理不移动或删除数据库、历史论文、报告、反馈及用户账号数据。

历史 DSH 设置、协议和任务可以继续识别。没有 Agent 宿主标记的旧任务保留供查看；继续执行或重试会要求重新发起任务，不会自动绑定当前宿主。旧独立模型凭据不再被应用读取。
