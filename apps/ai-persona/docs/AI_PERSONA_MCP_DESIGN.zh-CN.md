# AI Persona：MCP 查询与提案接口

> 设计与历史参考：本文可能包含早期阶段或规划，不是本次发行的验收报告。当前入口与能力以[使用指南](../../../docs/GETTING_STARTED.zh-CN.md)和[兼容矩阵](../../../docs/FEATURE_PARITY.md)为准。

状态：2026-09-09 开发版新查询接口。旧 MCP 查询已移除，不提供双版本连接或兼容适配器。保留现有偏好触发、对话学习、待审核提案与变化同步流程。

查询只读取正式生效记录与其声明来源。来源文件是数据，不能成为服务端指令；Agent 不能传任意宿主路径。写入只创建 Pending Proposal，审核与发布能力不注册为 MCP 工具。

**当前工具面**

| 职责 | Tool |
|---|---|
| 地图与任务搜索 | `get_knowledge_map`、`search_knowledge` |
| 已知记录精读 | `get_persona_records` |
| 偏好维护检索 | `search_preferences`、`get_preference_records`（含暂停场景；不触发偏好应用） |
| 来源浏览、定位、读取 | `list_source_files`、`search_source_content`、`read_source` |
| 既有偏好流程 | `resolve_persona_activation`、`prepare_preference_context` |
| 既有对话学习 | `ingest_conversation_event`、`get_conversation_learning_status` |
| 待审核提案与同步 | `propose_change_set`、`get_proposal_status`、`list_persona_changes` |

六个查询的完整参数、结构与调用示例见[查询工具设计](AI_PERSONA_AGENT_QUERY_TOOLS_PROPOSAL.zh-CN.md)。严格范围与版本规则见[范围查询契约](AI_PERSONA_SCOPED_MCP.zh-CN.md)。偏好流程见[模型集成](AI_PERSONA_MODEL_INTEGRATION.zh-CN.md)。本文件保留提案与变化同步的原有契约。

**查询与读取行为**

- `get_knowledge_map` 交付节点内容、个人状态和正式关系，可全局分页或按已知 ID 展开 1—2 跳。孤立课程和未分类内容可在未限定查询中发现。
- `search_knowledge` 结合名称、正文、关系陈述、来源片段与本地多语言向量。关系扩展独立召回，候选不必再次匹配关键词。结构化筛选只限制主要命中，必要路径节点以 context 标记。
- `get_persona_records` 最多批量读取 10 个知识、课程或材料记录。长正文续读与逐项失败均明确返回；它不负责重新选择偏好。
- 来源工具接受材料 source_ref 或既有偏好样本 source_ref。文件夹按声明的相对路径浏览，文件用 source_id + file_id 定位；读取前验证原件 hash。
- Markdown/文本支持行、章节和片段定位；PDF 支持文字、目录和实际页面图像；CSV/TSV 支持 A1 范围；常见栅格图片可直接返回。未实现 OCR、Word、PowerPoint、Excel 解析。
- 语义模型失败或文件解析不完整时明确报告降级。没有匹配不等于用户不懂，检索分数不改变正式掌握程度。

**输出与一致性**

新查询的 MCP structuredContent 直接返回 `ai-persona.query-result/v2`，不套旧 `result` 包装。共用字段为 tool、ok、request_id、persona_revision、scope、data、coverage、next_cursor、warnings、error。文本内容块序列化同一对象；宿主应避免重复注入。图像是独立 MCP image 内容块，data.images 以内容块位置对应页码、尺寸和来源。

单次查询共享正式记录快照与发布锁。继续读取的 cursor 绑定业务条件、范围、实际记录内容与模型管线版本；记录在开发阶段被直接编辑也会使旧游标失效。expected_persona_revision 检查失败返回 version_changed，不能读取虚构的历史快照。查询派生缓存按内容 hash 更新，无需为新查询手动构建旧全文索引。

scope 是调用方约束，当前本地连接可访问整个配置工作区；它不是多租户授权系统。若以后提供不同 Agent 的固定权限，需要在连接侧新增服务端边界，不能仅依赖 Agent 自觉传 scope。

实现入口：[工具注册](../src/ai_persona/query_mcp.py)、[查询服务](../src/ai_persona/query_service.py)、[来源读取](../src/ai_persona/query_sources.py)、[本地检索](../src/ai_persona/query_retrieval.py)。

以下提案与变化同步接口沿用现有实现。

## 12. Tool：`propose_change_set`

### 12.1 用途

由 Agent 提交一组相互关联、但尚未生效的 Persona 变化。

这是 MCP 唯一的非只读 Tool。它只创建 Pending ChangeSet 和 Proposal。

### 12.2 支持的操作

v1 支持：

- `create`
- `update`
- `archive`
- `restore`
- `relate`
- `unrelate`

`merge` 和 `split` 留给后续版本。Agent 如发现需要合并或拆分，应在 `reason` 和 `conflicts` 中说明，或提交原子化的新候选供用户分别审核。

### 12.3 支持的对象

- `knowledge_node`
- `course`
- `material`
- `tag`
- `relation`
- `evidence`
- `preference_context`
- `preference`
- `preference_example`

创建 Material、Evidence 或 Preference Example 时只能引用已经存在并允许使用的 `source_id`。MCP 不创建新 Source。

### 12.4 输入

```json
{
  "idempotency_key": "run_20260904_01:candidate_batch_01",
  "observed_persona_revision": 42,
  "proposal_context": {
    "kind": "general"
  },
  "summary": "根据用户明确反馈更新科研绘图偏好",
  "changes": [
    {
      "client_ref": "avoid-rainbow",
      "operation": "create",
      "entity_type": "preference",
      "values": {
        "scope": "contexts",
        "context_refs": ["pctx_research_figure"],
        "behavior": "avoid",
        "instruction": "科研图中不要使用彩虹色图。",
        "condition": ""
      },
      "reason": "用户明确表示以后科研图不要使用彩虹色图。",
      "confidence": 1.0,
      "evidence_refs": ["ev_user_feedback_01"]
    }
  ]
}
```

### 12.5 Change 通用字段

| 字段 | 必填 | 说明 |
|---|---:|---|
| `client_ref` | create/relate 建议 | ChangeSet 内唯一临时引用，不是正式 ID |
| `operation` | 是 | 支持的领域操作 |
| `entity_type` | 是 | 目标对象类型 |
| `target_id` | 修改类操作是 | 已存在的稳定 ID |
| `expected_record_revision` | 修改类操作是 | Agent 读取目标时看到的对象 revision |
| `values` | 按操作 | 经过领域 Schema 约束的候选值 |
| `reason` | 是 | 为什么建议该变化及主要依据 |
| `confidence` | 是 | 0 到 1，表示提取判断置信度，不是知识水平 |
| `evidence_refs` | 按语义要求 | 已存在 Evidence ID |
| `evidence` | 否 | 材料型提案的内联原文定位；服务端生成 Evidence |
| `conflicts` | 否 | Agent 已发现但不能裁决的冲突 |

服务端忽略或拒绝 Agent 提交的内部字段，不允许透传到正式模型。

### 12.5A 材料型 ChangeSet

材料分析仍使用同一个 `propose_change_set`，不增加 `propose_material_enrichment`。调用方设置：

```json
{
  "proposal_context": {
    "kind": "material",
    "material_id": "mat_tebd_note",
    "source_id": "src_tebd_note",
    "source_hash": "sha256:..."
  }
}
```

每个 create、update 或 relate Change 可以附带至多 20 个内联 Evidence：

```json
{
  "file": "original.md",
  "line_start": 120,
  "line_end": 138,
  "evidence_kind": "authored_material",
  "confidence": 0.9
}
```

v1 只接受 Manifest 声明的文本文件和最多 500 行的有效范围。每个 Change 最多带 20 项、整个 ChangeSet 最多带 100 项内联 Evidence，服务端生成的 excerpt 总量不得超过 500,000 bytes。服务端读取对应行并生成不可由 Agent 改写的 excerpt，预分配 Evidence ID，并把 Evidence 引用写入目标知识点、Material 或 Relation。目标对象和这些 Evidence 属于同一个 Proposal：拒绝时都不生效，接受时在同一文件事务和 Persona revision 中发布，因此不会产生悬空引用。

材料上下文中的 Knowledge 和 Relation 变化必须带内联 Evidence 或引用已有 Evidence。当 Source hash、Material 的 source_ref 或引用行内容在提交后变化时，提案标记为 stale。`authored_material` Evidence 还要求 Material 的 `user_relationships` 包含 `authored`。仅有 `read_signal` 或 `inferred_pattern` 时不能把 Knowledge Level 提升为 `familiar` 或 `proficient`；高掌握程度需要明确用户陈述、作者材料、用户反馈或人工编辑证据。

### 12.6 ChangeSet 内部引用

同批新对象可使用 `client_ref` 相互引用：

```json
{
  "client_ref": "rel-material-tebd",
  "operation": "relate",
  "entity_type": "relation",
  "values": {
    "source_id": "mat_existing",
    "target_ref": "new-tebd",
    "relation_type": "covers",
    "knowledge_role": "method",
    "salience": "primary",
    "statement": "该材料使用 TEBD 计算一维量子系统的实时演化。"
  },
  "reason": "材料方法部分明确使用 TEBD。",
  "confidence": 0.92,
  "evidence_refs": ["ev_method_section"]
}
```

服务端在生成 Proposal 时解析引用，并可以预分配稳定的候选对象 ID，以便 Proposal 和依赖关系形成可审核的完整结构。候选 ID 必须明确标记为未生效；在用户发布前，使用该 ID 的正常查询仍返回 `not_found`。

### 12.7 校验顺序

提交前执行：

1. MCP input schema 校验；
2. ChangeSet 大小和临时引用唯一性校验；
3. 各领域对象 schema 校验；
4. `source_id`、Tag、Evidence 和关系端点引用校验；
5. active/archived 状态约束；
6. 对象 revision stale 检查；
7. 确定性重复检查；
8. 模糊重复候选和语义冲突提示；
9. 依赖图与循环依赖检查；
10. 整个 ChangeSet 持久化。

结构非法时不创建任何 Pending Proposal。模糊重复或无法自动裁决的语义冲突可以进入审核队列，但必须附带警告。

### 12.8 Revision 规则

`observed_persona_revision` 用于记录 Agent 生成候选时所依据的全局版本：

- 全局 revision 变化但目标对象未变化时，不必自动拒绝整个 ChangeSet；
- update、archive、restore 和 unrelate 必须严格比较 `expected_record_revision`；
- 服务端从当前正式记录计算 `base_hash`，Agent 不提供 hash；
- create 和 relate 必须对当前最新正式记录重新执行重复和引用检查；
- 并发变化可能影响语义时，Proposal 标记 conflict 或要求 Agent 重新查询。

### 12.9 幂等规则

`idempotency_key` 必填：

- 相同 client、相同 key、相同规范化 payload：返回原 ChangeSet；
- 相同 client、相同 key、不同 payload：返回 `idempotency_conflict`；
- 网络结果不确定时，Agent 使用相同 key 重试；
- Agent 不应通过生成新 key 重复提交同一候选。

### 12.10 输出

```json
{
  "ok": true,
  "schema_version": "ai-persona.proposal-submit/v1",
  "persona_revision": 42,
  "request_id": "req_...",
  "change_set_id": "chg_...",
  "status": "pending_review",
  "effective_change": false,
  "proposals": [
    {
      "proposal_id": "prop_...",
      "client_ref": "avoid-rainbow",
      "candidate_record_id": "pref_...",
      "operation": "create",
      "entity_type": "preference",
      "status": "pending_review",
      "duplicate_candidates": [],
      "conflicts": []
    }
  ],
  "atomic_groups": [],
  "dependency_groups": [],
  "warnings": [],
  "review_url": "http://127.0.0.1:8765/review?change_set=chg_..."
}
```

`review_url` 是给用户的本地导航信息，不是 Agent 审核接口，也不得包含鉴权 secret。

### 12.11 部分接受与审核依赖

一个 ChangeSet 是审核分组，不表示所有候选必须一起接受：

- 相互独立的 Proposal 可分别接受、拒绝或暂缓；
- 引用同批新对象的 Proposal 组成依赖组；
- 依赖 Proposal 只有在所有前置 Proposal 已接受或编辑后接受时才能发布；
- 用户拒绝被依赖的新对象后，所有直接和间接依赖它的待审核/暂缓 Proposal 同步拒绝；
- 拒绝子 Proposal 不反向拒绝它的前置 Proposal；
- 暂缓前置 Proposal 时，子 Proposal 保留但处于阻塞状态；
- ChangeSet 允许部分接受，每个被接受的 Proposal 仍单独发布并增加一次 Persona revision；
- `dependency_groups` 是真实依赖语义；`atomic_groups` 仅为 v1 兼容字段，不代表整组原子发布；
- UI 必须清楚展示依赖和受影响对象。

自动级联拒绝在同一审核锁中完成，并为子 Proposal 记录 `decision_source=dependency_cascade` 和 `decision_parent_id`。独立的、只引用已发布对象的 Proposal 不受级联决策影响。

## 13. Tool：`get_proposal_status`

### 13.1 用途

Agent 在用户要求检查结果时，查询自己已获得 handle 的 ChangeSet。该 Tool 不用于频繁轮询，也不提供列出全部审核队列的能力。

### 13.2 输入

```json
{
  "change_set_id": "chg_..."
}
```

### 13.3 输出

```json
{
  "ok": true,
  "schema_version": "ai-persona.proposal-status/v1",
  "persona_revision": 43,
  "request_id": "req_...",
  "change_set_id": "chg_...",
  "status": "partially_accepted",
  "dependency_groups": [],
  "proposals": [
    {
      "proposal_id": "prop_1",
      "status": "accepted",
      "published_persona_revision": 43
    },
    {
      "proposal_id": "prop_2",
      "status": "rejected",
      "published_persona_revision": null
    }
  ],
  "review_url": "http://127.0.0.1:8765/review?change_set=chg_..."
}
```

### 13.4 可见范围

- v1 不提供 `list_pending_proposals`；
- 只有持有不可猜测 `change_set_id` 的调用者可以查询；
- 如果 Host 提供稳定 client identity，服务端还应校验 ChangeSet 的提交 client；
- 不返回完整人工审核备注；
- rejected 结果只返回状态和可公开的简短原因类别；
- 不把审核状态变化自动解释为用户新的偏好。

## 14. Tool：`list_persona_changes`

### 14.1 用途

读取某个 Persona revision 之后已经发布的变化，用于：

- Agent 缓存失效；
- 长任务重新准备上下文；
- 确认某个对象何时进入有效 Persona；
- 增量同步只读状态。

### 14.2 输入

```json
{
  "since_revision": 40,
  "limit": 20,
  "cursor": null
}
```

### 14.3 输出

```json
{
  "ok": true,
  "schema_version": "ai-persona.change-list/v1",
  "persona_revision": 43,
  "request_id": "req_...",
  "from_revision": 40,
  "to_revision": 43,
  "changes": [
    {
      "persona_revision": 43,
      "published_at": "2026-09-04T12:00:00Z",
      "object_id": "pref_...",
      "entity_type": "preference",
      "operation": "create",
      "old_record_revision": null,
      "new_record_revision": 1
    }
  ],
  "next_cursor": null
}
```

### 14.4 隐私约束

只返回变化元数据和 Agent 可读取的对象 ID，不返回：

- 私密人工审核备注；
- rejected 或 deferred Proposal 内容；
- 被可见范围禁止的对象摘要；
- 原始 Source 内容；
- 用户设备路径。
