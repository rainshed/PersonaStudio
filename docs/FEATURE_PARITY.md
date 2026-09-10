# Page and feature compatibility / 页面与功能兼容

This inventory describes the existing AI Persona surface retained in the PersonaStudio application. It is a compatibility contract for refactoring, not a claim that every integration has been tested on every platform. Runtime verification should use the fictional Demo and temporary workspaces.

本表记录迁入 PersonaStudio 后需要保留的页面与行为，作为重构回归依据。它不代表所有集成都已在所有平台验收；验证应使用虚构 Demo 和临时工作区。

## Browser pages / 网页

| Area / 功能 | Entry / 入口 | Retained behavior / 保留行为 |
| --- | --- | --- |
| Overview / 概览 | `/` | Pending review, failures, recent publication, and expandable asset statistics / 待审核、异常、最近发布和资产统计 |
| Knowledge / 知识 | `/knowledge`, `/knowledge/new`, `/knowledge/{id}`, `/knowledge/{id}/edit` | Search, filtering, table, detail, manual edit, archive, tags, and relationships / 搜索筛选、详情、编辑、归档、标签与关系 |
| Knowledge graph / 知识图谱 | `/knowledge` | Multiple relation types, layouts, zoom, pan, minimap, collapse, search, fullscreen, and return-state retention / 多关系布局、缩放平移、小地图、折叠搜索、全屏和返回状态 |
| Courses / 课程 | `/courses`, `/courses/new`, `/courses/{id}`, `/courses/{id}/edit` | Listing, detail, knowledge links, manual maintenance, and archive / 列表详情、知识关联、维护与归档 |
| Materials / 材料 | `/materials`, `/materials/new`, `/materials/{id}`, `/materials/{id}/edit` | Browse, filter, upload, paste, URL/arXiv/DOI import, draft preview, duplicate checks, archive, and restore / 浏览筛选、上传粘贴、链接导入、预览查重、归档恢复 |
| Source reading / 原文 | `/materials/{id}/source`, `/source-text`, `/source-manifest` under the material | Original file, extracted text, manifest, immutable source versions, and hash checks / 原文件、提取文本、清单、不可变来源版本与哈希校验 |
| Material evidence / 材料证据 | Material detail and relation/source editing pages | Knowledge links, roles, importance, notes, evidence, and versioned source replacement / 知识关联、角色、重要性、说明、证据与来源版本 |
| Preferences / 偏好 | `/preferences`, `/preferences/new`, `/preferences/items/{id}/edit` | Global and contextual rules, folders, ordering, editing, state changes, and archive / 全局与场景规则、分组排序、编辑、状态与归档 |
| Preference contexts / 偏好场景 | `/preferences/contexts/new`, `/preferences/contexts/{id}/edit` | Editable task context and activation conditions / 场景与触发条件维护 |
| Preference examples / 偏好样例 | `/preferences/examples/new`, `/preferences/examples/{id}/edit`, file views | Positive/negative examples, uploaded resources, and file inspection / 正反样例、上传资源与文件查看 |
| Activation trial / 偏好试用 | `/preferences/try` | Trial activation with the configured model and visible matching results / 使用所选模型试运行并查看匹配结果 |
| Feedback and review / 反馈与审核 | `/inbox` | Pending, feedback, and full-history views; filters, detail, diff, edit-and-accept, accept, reject, defer / 待审核、反馈与历史、筛选详情、差异、编辑通过、拒绝暂缓 |
| Legacy review links / 原审核链接 | `/review`, `/review/{id}` | Continue to resolve to the unified inbox or selected record / 保留链接身份并进入统一工作台 |
| Learning history / 学习历史 | `/learning` | Existing entry resolves to the learning records in the unified workflow / 原学习入口继续连接相应记录 |
| Preference application history / 应用记录 | `/preferences/applications` | Existing entry and record identity retained through the unified feedback workflow / 保留原入口与记录身份 |
| AI maintenance / AI 维护 | `/ai` | Conversation, source/text/PDF/image references, target scope, multi-step candidates, review submission, and recovery / 对话、参考依据、对象范围、多轮候选、送审和恢复 |
| Evaluation / 评测与改进 | `/evaluations` | Personal cases, feedback references, frozen suites, isolated runs, reports, comparison, and improvement workflows / 样例、反馈参考、固定测试集、隔离运行、报告比较与改进 |
| Model settings / 模型设置 | `/settings/models` | Accounts, supported authentication, custom compatible endpoints, task routing, reasoning choices, tests, and optional fallback / 账号认证、兼容服务、任务路由、思考强度、测试与备用模型 |
| Application settings / 应用接入 | `/settings?tab=sources` | Local/remote Codex source configuration, scope, context, Hook installation, and verification / 本机与远端来源、范围、前文、Hook 安装及验证 |
| Automatic features / 自动功能 | `/settings?tab=capabilities` | Independent learning and preference-application controls, worker state and budgets / 独立开关、后台状态与预算 |
| Data settings / 数据管理 | `/settings?tab=retention` | Retention and cleanup controls; evaluation exports remain available in their workflow / 保留与清理设置；评测导入导出保留原入口 |
| Language and mobile / 语言与移动端 | All pages; `/language` | English/Chinese interface, responsive navigation, inline details, and protected unsaved edits / 中英文、响应式导航、就地详情与未保存保护 |

AI Assistant → Read a paper → multiple sources: `/extract` — Codex-backed single/batch material reading, editable rules, evidence-linked graph preview and pending proposals. This new page currently uses Chinese labels; existing page translations remain available. See the [current usage guide](../apps/ai-persona/docs/AI_PERSONA_EXTRACTION_USAGE.zh-CN.md).

## Commands and integrations / 命令与集成

| Surface / 功能 | Entry / 入口 | Contract / 行为约定 |
| --- | --- | --- |
| Local lifecycle / 本地管理 | `ai-persona start`, `serve`, `status`, `logs`, `stop`, `configure` | Existing names remain; foreground/background operation and workspace identity checks / 保留命令名、前后台启动与工作区识别 |
| Setup and diagnostics / 上手诊断 | `setup`, `doctor` | Additional local onboarding and environment diagnostics / 新增本地设置与环境诊断 |
| Storage and retrieval / 存储检索 | `init`, `validate`, `build`, `search`, `prepare` | File-first records, deterministic projections, revisions, SQLite search, and context preparation / 文件记录、确定性投影、版本历史、检索与上下文 |
| Workspace lifecycle / 工作区维护 | `backup`, `restore`, `migrate` | Separate copies and explicit destinations; existing destinations are not overwritten / 独立副本、显式目标、不覆盖已有目录 |
| Model runtime / 模型运行时 | `models-install`, `models-stop` | Optional pinned adapter; runtime cache outside the installed Python package / 可选固定依赖，运行时缓存外置 |
| MCP local / 本地 MCP | `ai-persona-mcp --workspace …` | stdio transport, scoped reads, source access, pending proposals, and publication history / stdio、范围查询、来源读取、待审核提案与发布历史 |
| Semantic retrieval / 语义检索 | Knowledge/source MCP tools | Local embeddings, text and graph retrieval, source scope, versioned results, and explicit degraded coverage / 本地嵌入、文字与图检索、范围和版本、明确降级状态 |
| Preference maintenance MCP / 偏好维护 MCP | `search_preferences`, `get_preference_records` | Read reviewed preferences, contexts and examples without activating or changing them / 查询正式偏好、场景与样例，不触发应用或修改 |
| Human review boundary / 审核边界 | Studio and MCP | Manual saves take effect; AI/MCP changes stay pending until reviewed; MCP has no accept/publish tool / 人工保存生效，AI 提案须审核，MCP 不提供通过或发布能力 |
| Codex integration / Codex 接入 | Settings; `codex-hook`, `learning`, `preferences-apply` | Scoped capture, independent opt-ins, source trust, deduplication, background learning, and preference context / 范围采集、独立启用、来源信任、去重、后台学习与偏好上下文 |
| Remote Codex / 远端 Codex | `remote setup`, `start`, `stop`, `status`, `supervise` | Token-authenticated HTTP MCP, unified Hook, and reconnecting SSH reverse tunnel / 令牌 HTTP MCP、统一 Hook 与自动重连 SSH 反向隧道 |
| Remote browser / 远端网页 | `AI_PERSONA_PUBLIC_ORIGIN` and an explicitly configured local proxy | Exact origin validation and loopback backend; remains single-user / 精确来源校验、本地监听，仍为单用户 |
| Prompt Workbench / 提示词工作台 | Evaluation improvement references; external service | Existing integration retained. Requires a separately running compatible service, normally localhost:4318; **not bundled in this repository** / 保留外部集成，需要单独运行兼容服务，本仓库不包含工作台应用 |
| Demo isolation / Demo 隔离 | `--demo` | Separate editable copy, account/state isolation, protected seed, no host Hook installation / 独立副本、账号状态隔离、模板保护、不安装宿主 Hook |

The current release target remains a local single-user application. Multi-user hosting and native Windows support are outside this compatibility claim. Future `paper-radar` or `promptbench` applications do not exist in this checkout.

当前范围是本地单用户应用，不宣称多用户部署或原生 Windows 支持；未来的 `paper-radar`、`promptbench` 不在本版目录中。
