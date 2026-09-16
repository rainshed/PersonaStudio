> 历史设计或验证记录。当前结构与运行方式以 [项目说明](../../../README.md) 为准；独立模型功能已移除。

# 宿主边界与可复现交付（0.2）

论文业务、通用 Agent 阅读工具、模型宿主现在使用不同的模块边界。现有论文、报告和任务快照的协议版本保持不变，更新代码不会使历史结果自动绑定到新模型。

## 模块与依赖

- `server/analyses`、`daily`、`discussions` 管理论文业务与持久化。
- `server/agents/research-tools.mjs` 提供按需阅读、Persona 范围约束和实际交付证据账本；`autonomous-task.mjs` 管理研究目标、结构化提交、输出校验和提示词捕获。
- `server/hosts/service.mjs` 只按冻结设置选择适配器；`codex` 和 `dsh` 分别管理宿主连接、认证、工具传输、取消和计量。独立模型服务继续拥有独立适配入口。
- `packages/host-contract` 是有显式版本的 `@paper-radar/host-contract` 包。Web 与 DSH 插件通过包的 `exports` 使用共享的传输错误、路由、初筛协议和执行能力描述。Codex 和论文业务不再引用插件的源码路径。通用研究工具的旧路径保留兼容导出。

`executionPoolForSettings(settings)` 返回 `dsh`、`codex` 或 `independent`；`capabilitiesForSettings(settings)` 给出并发、取消、Agent 和提交能力。已经冻结的任务使用自己的宿主标识；当前适配器不能执行历史独立任务时，明确返回 `legacy_model_snapshot`，由用户重新发起。

## 任务调度与宿主并发

任务运行层负责论文任务的排队、恢复与生命周期。宿主适配器负责实际模型调用的最终并发限制，两层不会把同一个调用重复计数。

各宿主的计数单位保持明确：DSH 为一次模型尝试，Codex 为一个 Agent turn（内部可能包含多次工具与模型往返），独立模型为一个生成请求（包含其有限重试）。`capabilities.concurrencyUnit` 标识这一差别。宿主用 `attemptUnit` 描述用量记录单位：Codex 为整个 turn，DSH 与独立模型为模型尝试；每条实际尝试记录携带 `attempt_unit`。无法识别的宿主单位明确标为 `unknown`；不同宿主的尝试次数不能直接当作相同的供应商调用次数比较。

所有宿主使用共享的 `PriorityAdmission`：讨论优先级 30、主动分析 20、手动日报 10、自动日报 0。同一优先级保持先到先运行，等待中的任务每 30 秒提升一级，保证持续新增的交互请求不会使后台工作永远排不到。优先级只影响等待队列，不中断已运行的模型调用。调低并发时现有调用继续完成，新调用等待空位。

`run` / `runAgent` 接受 `options.priority`；未提供时读取任务上下文。DSH 在发起任务时保存优先级，因此之后经 HTTP 返回的 admission callback 仍使用原任务优先级。

Codex 等待结果前检查取消信号，并在完成后删除监听器，处理“取消发生在宿主启动与监听建立之间”的竞态。工具返回后再次检查取消，避免把取消后的迟到提交记录成成功。临时回调 socket 存在私有短路径目录，避免长数据目录超出 Unix socket 长度限制。

## 干净安装与验证

保留以下目录结构；Web 的 Git 历史与外层项目/插件历史继续独立：

```text
workspace/
  paper-radar/
    release.json
    scripts/
    web/
      packages/host-contract/
  paper-radar-dsh-plugin/
```

从已有源码布局或解压后的源码包运行：

```sh
node paper-radar/scripts/setup.mjs --verify
```

脚本检查 `release.json` 的 Web 0.2.0、host-contract 1.0.0、插件 0.4.0，使用两个提交到仓库的锁文件安装依赖，然后运行插件测试、Web 类型/规范/测试检查和生产构建。Node.js 要求为 22.19 或更新版本。`--check-only` 重用已安装依赖，只运行版本检查与验证。

插件测试依赖通过 npm 锁文件安装，不再要求某位开发者的 `~/.npm/_npx` 目录。实际 DSH 安装仍需已验证的宿主版本 0.1.5-rc.1。安装脚本把共享契约复制到插件安装目录，使已经安装的插件不依赖源码位置；它不会把开发依赖替换成宿主目录。常规 setup 不安装插件到运行中的 DSH，不启动服务，不使用模型账号。

AI Persona 的真实 MCP 集成测试是可选项；缺少对应 Python 环境时明确显示 skip，其余自动测试使用隔离数据与宿主替身。在线模型与用户登录环境仍须在实际部署后单独验证，自动测试不会消耗真实模型额度。

## 可审查的发布包

```sh
node paper-radar/scripts/package-release.mjs
```

输出到 `paper-radar/releases/`。源码包包括两个组件、共享契约、锁文件和安装脚本；`release-manifest.json` 记录组件版本、两个源码仓库的 Git revision/修改状态，以及每个交付文件的 SHA-256。压缩包另附 SHA-256 文件。源码包不会改变仓库历史，也不自动发布或部署。

本机数据库、账号配置、报告缓存、依赖目录、Git 元数据和本地评测输出不进入源码包。业务中的 `server/evaluations` 等源码正常交付。调整组件版本时同时更新 package.json、锁文件和 `release.json`，重新生成并验证源码包。
