# Paper Radar

本机运行的论文研究应用：读取 arXiv 公告与正文，按用户选择的 AI Persona 知识范围筛选论文，生成报告，并通过用户反馈评估推荐效果。

分析agent目前仅支持 **Codex** 和 **DSH（DeepSeek Harness）**。

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

普通启动直接引导连接 AI Persona、创建订阅，再配置 Codex 或 DSH 生成报告。
