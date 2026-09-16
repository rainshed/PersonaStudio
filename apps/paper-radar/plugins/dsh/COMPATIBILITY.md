# 宿主兼容记录

以下是真实宿主联调的历史记录：2026-09-10，插件版本 0.3.0。本次目录调整与 DSH 重命名另经自动测试验证，尚未重新进行真实宿主联调。

历史补充验证：2026-09-15，0.5.0 在同一 DSH 0.1.5-rc.1 web profile 的隔离运行环境中，已确认论文资料进入原生、可编辑的会话草稿，沿用工作区及原生模型选择。验证没有发送问题或调用模型；此前模型执行能力的验收范围仍以下表及历史记录为准。

| 项目 | 验证环境 |
| --- | --- |
| 宿主 | `@deepseek-ai/dsh` 0.1.5-rc.1，web profile |
| LLM 能力 | `@deepseek-ai/dsh-llm` 0.1.5-rc.1，peer dependency |
| 运行环境 | macOS、Node.js 24.13.0、同用户本机 Unix socket |
| 实际默认模型 | `openai-codex / gpt-5.6-luna` |
| 模型目录 | 本机已注册 DeepSeek、Kimi、OpenAI Codex 三个平台；逐一调用所有平台未验收 |
| 业务服务 | 当前工作区 `paper-radar/web`，端口 4317 |
| DSH | 本机端口 3080，后台运行 |

0.6.0 已移除上述讨论草稿及业务入口；0.5.0 的记录仅描述历史验证。

## 使用的宿主接口

接口依据为该安装版本的实现和类型声明，集中在 `src/host-models.mjs`、`src/host-agents.mjs`、`src/index.mjs` 和 `src/client.js`，没有将宿主内部逻辑散布到业务阶段。

| 用途 | 当前适配点 |
| --- | --- |
| 平台和模型目录 | `llm.listProviders`、`listModels`、`resolveModelInfo` |
| 解析具体模型与强度 | `llm.resolveCallConfig` |
| 执行、取消和用量 | `llm.prepareCall` 返回的单次 `stream`，使用宿主消息构造器和 AbortSignal |
| 初筛 Agent | `agents.create`、`followup`、`whenIdle`、`cancel`、`dispose` |
| 每篇工具与输入隔离 | scope `tools.restrict`、`tools.presentAs(native)`、`systemPrompt.suppressRuntimeContext`、complete system section |
| 逐次预算与用量 | `agent/request`、`agent/assistant-stream`；请求前回调业务预留额度，结束后记录并释放名额 |
| 结果与有限修订 | `screening_submit_result`、`tools/result`、`exec.concludeTurn()`、`agent/turn-stopping` |
| 默认模型 | `agentDefaultModel.currentSelection` |
| 发起会话设置 | `agents`、`sessionProjections` 的 modelSelection、会话请求头 |
| 领域工具 | `tools.register`，结构化输出及 presentationMeta |
| 原生卡片 | `dsh.client`、ModuleLoader、`tool.call.toolview` keyed slot |
| 卡片操作 | `connection.fetch.register` 的 `/api/paper-radar`，沿用宿主登录与来源保护 |
| 网页后台模型调用 | 权限 0600 的 Unix socket，不暴露到手机或公网 |

此版本的客户端资源由宿主发布带版本号的 combo URL；不能用自造的 `/plugins/paper-radar/client.js` 判断是否安装成功。验收读取宿主实际发布的资源地址。

`connection.rpc.handle` 在本机版本出现服务注入异常，最终使用该版本可用的 `connection.fetch.register`。这是适配实现选择，未修改 DSH 自身代码。

## 升级边界

- 安装器拒绝未经本项目验收的 DSH 版本，避免插件加载后才发现能力不兼容。
- 更新宿主时须重新检查目录、强度能力、会话选择、取消传播、工具元数据、原生卡片和真实调用。
- 宿主模型参数或认证在任务期间发生不兼容变化时，任务明确失败；不自行换模型，也不重新读取旧独立账号。
- 保存路由时校验全部任务设置。若宿主移除了某项已引用的模型，需要在 PaperRadar 路由中恢复继承或改选可用模型后再创建任务。
- 关闭浏览器不影响后台模型通道；停止 DSH 运行时会使新模型任务不可用。浏览历史和来源检查仍由业务服务提供。
- 计量元数据沿用宿主上报 token 数；无法取得价格时 cost 为空。没有把 token 数换算成猜测费用。

自主任务均使用 `agents.create`，创建时标记 `meta.origin = subagent`。保留原生 `agent/pre-step` 的待处理用户消息及自动上下文整理；当需主动整理时通过 `agentPresets.serviceFor(agent, 'compaction')` 定位所属 Agent 的服务。不能在宿主全局注入 `compaction`，也不能把整段会话历史当成 pre-step 的新增消息。

`llm/stream` 按 sessionId 捕获 purpose=compaction 的辅助调用，沿用任务模型、思考强度、取消信号及逐次预算。`agent/request-error` 不继承主聊天的无界重试。临时平台错误仍仅按用户已配置的备用策略执行一次备用，业务总预算不重置。工具修正不规定研究方法。

自主工具定义和提交接口由业务任务传入。单篇结果为现有 analysis.v1 栏目，执行身份为 paper-radar.autonomous.v1；每日初筛为 screening.autonomous.v1，旧结果仅保留查看，不批量重跑。

Windows、多个用户、多宿主业务部署、云端发布、持久 Agent 会话恢复、原生图像理解不在本次已验证范围。真实联调启动隔离宿主并复用既有认证，不修改生产模型路由。详情见 [0.3.0 验收](../../docs/archive/dsh/AUTONOMOUS_VALIDATION.zh-CN.md)。
