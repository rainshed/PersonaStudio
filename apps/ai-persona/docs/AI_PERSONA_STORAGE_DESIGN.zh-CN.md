# AI 电子人格：存储与投影设计

> 设计与历史参考：本文可能包含早期阶段或规划，不是本次发行的验收报告。当前入口与能力以[使用指南](../../../docs/GETTING_STARTED.zh-CN.md)和[兼容矩阵](../../../docs/FEATURE_PARITY.md)为准。

| 字段 | 内容 |
|---|---|
| 文档状态 | 讨论稿 |
| 版本 | 0.1 |
| 日期 | 2026-09-01 |
| 适用项目 | AI 电子人格 Greenfield 重构 |
| 关联需求 | [AI_PERSONA_PRD.zh-CN.md](./AI_PERSONA_PRD.zh-CN.md) |
| 兼容策略 | 不兼容现有 ScholarAlign 存储格式；旧项目只作为经验参考 |

## 1. 文档目的

本文档定义 AI 电子人格中知识、课程、材料、关系、证据和任务偏好的保存方式，以及如何从同一批正式记录生成：

- AI 可读取的结构化快照；
- 人类可阅读和审核的视图；
- Agent 可调用的任务上下文；
- 可删除、可重建的检索索引。

本文档关注数据边界、对象模型、目录、文件格式、关系图、审核和版本机制，不定义具体 UI 视觉样式，也不定义某个模型供应商的提取实现。

## 2. 核心设计结论

1. 系统只维护一套语义事实来源：**已审核的正式记录**。
2. 正式记录采用“一对象一个文件”的 Markdown + 严格 YAML frontmatter。
3. AI JSON 快照、人类汇总视图和 SQLite 索引都是可重建投影，不可独立成为事实来源。
4. 知识使用允许多父节点的有向图保存，不使用文件夹路径表达知识层级。
5. 三种知识实体为 `knowledge_node`、`course` 和 `material`。
6. `knowledge_node.semantic_role` 描述领域、概念、方法或技术等语义角色；关系决定真实层级。
7. 知识水平与兴趣分别保存，不沿父子关系自动传播。
8. 偏好由 `PreferenceContext`、`Preference` 和 `PreferenceExample` 三类独立对象组成；运行时合并全局偏好与命中场景的偏好。
9. AI 可以读取正式记录并创建候选，但不能直接修改、接受或删除正式记录。
10. 所有已生效变化都增加全局 `persona_revision`，同时保留对象 revision、来源和审核历史。

## 3. 总体数据流

```text
原始材料 / 人工修改 / 使用反馈
                │
                ▼
        结构化 Change Proposal
                │
                ▼
      校验、去重、冲突分析、审核
                │
                ▼
       Canonical Approved Records
                │
      ┌─────────┼────────────┬──────────────┐
      ▼         ▼            ▼              ▼
AI JSON 快照  人类视图   SQLite 检索索引   Preference Runtime View
      │         │            │              │
      └─────────┴────────────┴──────┬───────┘
                                    ▼
                        MCP / CLI / Local API
```

不采用以下数据流：

```text
AI 文件 → 人类文件 → AI 文件
```

两个可编辑版本互相同步会产生循环、冲突和权威性不明。AI 版和人类版必须从同一正式记录单向生成。

## 4. 数据分层

### 4.1 原始来源 `Sources`

保存用户授权导入的文章、PDF、note、对话、简历、课程材料和样本。来源应尽量保持原始字节，并带 manifest 和内容 hash。

来源只证明“材料中写了什么”，不直接证明用户认同、精通或长期偏好。

### 4.2 待审核提案 `Proposals`

保存尚未生效的新增、修改、归档、合并、拆分和关系候选。AI 产生的语义变化只能先进入这一层。

Pending proposal 不进入正常 Agent 上下文，也不进入正式 AI 快照。

### 4.3 正式记录 `Records`

保存已经得到用户确认的当前有效状态。正式记录是唯一语义事实来源。

人类可以通过受支持的编辑流程修改正式记录；修改必须经过 schema 校验、冲突检查和 revision 发布。

### 4.4 审核与版本历史 `Revisions`

保存每个已应用变更批次的操作者、时间、对象、旧 hash、新 hash、审核决定和来源。历史用于审计与恢复，不作为日常检索入口。

### 4.5 生成投影 `Generated`

包括完整 AI 快照、Preference 编译结果和人类导航页面。生成投影不得手工编辑。

### 4.6 本地状态 `Local State`

包括 SQLite、FTS、关系闭包、缓存、锁和调用回执。它们不属于可移植人格数据，应默认从版本控制和同步中排除。

## 5. 推荐目录结构

可移植人格数据：

```text
persona-data/
  schemas/
    knowledge-node.v1.schema.json
    course.v1.schema.json
    material.v2.schema.json
    relation.v2.schema.json
    tag.v1.schema.json
    evidence.v1.schema.json
    preference-context.v1.schema.json
    preference.v1.schema.json
    preference-example.v3.schema.json
    change-proposal.v1.schema.json
    source-manifest.v2.schema.json

  records/
    knowledge-nodes/
    courses/
    materials/
    relations/
    tags/
    evidence/
    preference-contexts/
    preferences/
    preference-examples/

  sources/
    src_.../
      manifest.yaml
      original.pdf
      extracted.md

  proposals/
    pending/
    history/

  revisions/
    changes.jsonl

  generated/
    persona.snapshot.json
    preferences/
      global.md
      note.write.md
    human/
      home.md
      knowledge-tree.md
      by-level.md
      by-interest.md
      by-tag.md
      courses.md
      materials.md
      preferences.md
      review.md

  config/
    persona.toml
```

不可移植或可重建状态：

```text
persona-state/
  persona.sqlite3
  locks/
  cache/
  invocations/
  staging/
```

`persona-state` 默认位于用户本地状态目录，而不是 `persona-data` 内部。

### 5.1 空白人格初始化

新人格通过显式 `init` 命令创建。初始化结果可以不含任何正式记录，但必须能够立即通过校验、构建投影并打开维护 UI。

```toml
[persona]
id = "my-persona"
revision = 1
created_at = "2026-09-02T12:00:00Z"
include_human_notes_in_snapshot = true
```

初始化必须：

- 创建 `records`、`sources`、`proposals`、`revisions` 和 `config` 的完整目录；
- 生成当前版本的全部 JSON Schema；
- 生成空的 `persona.snapshot.json`、人类阅读投影和 SQLite 索引；
- 使用 `created_at` 作为空库投影的稳定生成时间，保证重复构建结果一致；
- 允许用户随后从 UI 添加第一条 Knowledge、Course 或 Material；
- 当 data 或 state 目录非空时拒绝执行，不覆盖或删除已有内容；
- 要求 data 与 state 相互独立，不能相同或互相包含。

空白人格从 persona revision 1 开始；第一次审核通过的正式修改进入 revision 2。

## 6. 文件与 schema 约定

### 6.1 正式对象格式

正式对象使用 Markdown + YAML frontmatter：

```markdown
---
schema: ai-persona.knowledge-node/v1
id: kn_...
entity_type: knowledge_node
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# 人类可读标题

可选的人类说明。
```

结构化语义以 frontmatter 为准。正文可以被全文检索，并可作为 `human_notes` 提供给 Agent，但不得覆盖 frontmatter 中的 ID、水平、关系或状态。

### 6.2 YAML 子集

为避免解析器差异，frontmatter 只允许 JSON 兼容的 YAML 子集：

- string、number、boolean、null、array、object；
- 不允许自定义 tag、anchor、alias 或 merge key；
- 不允许重复 key；
- 时间统一使用带时区的 ISO 8601 字符串；
- 枚举必须使用 schema 中定义的英文机器值；
- 文件以 UTF-8 保存，换行统一规范化。

### 6.3 ID

ID 由系统生成，使用对象前缀加 UUID/ULID，不从标题、路径或父节点推导。

建议前缀：

| 对象 | 前缀 |
|---|---|
| Knowledge node | `kn_` |
| Course | `crs_` |
| Material | `mat_` |
| Relation | `rel_` |
| Tag | `tag_` |
| Evidence | `ev_` |
| Source | `src_` |
| Preference pack | `pref_` |
| Preference rule | `rule_` |
| Preference example | `ex_` |
| Change proposal | `prop_` |

标题和路径可以变化，ID 永不变化。引用一律使用 ID，不能使用文件名或标题作为外键。

### 6.4 通用状态

正式记录第一版使用：

- `active`：当前有效；
- `archived`：不再参与正常检索，但保留历史和引用。

`pending`、`accepted` 和 `rejected` 属于 Proposal 状态，不允许混入正式对象的 `status`。

## 7. 知识实体模型

### 7.1 三种知识实体

| `entity_type` | 含义 |
|---|---|
| `knowledge_node` | 领域、方向、主题、理论、概念、模型、方法、技术或工具 |
| `course` | 课程或系统性学习单元 |
| `material` | 文章、note、论文、书、对话、简历或其他材料 |

这三类对象共享：

- 稳定 ID；
- 标题和别名；
- `knowledge_level`；
- `interest_level`；
- tag；
- 知识说明与个人掌握范围；
- 证据引用；
- 状态和 revision。

### 7.2 知识水平

`knowledge_level` 使用：

| 值 | 人类标签 | 含义 |
|---|---|---|
| `proficient` | 精通 | 能独立解释、应用、比较或批判性使用 |
| `familiar` | 熟悉 | 掌握主要内容，能跟随常见应用 |
| `aware` | 了解 | 知道其存在或有有限接触 |
| `unspecified` | 未设置 | 尚未记录程度，不属于已设置程度的排序 |

知识点、课程和材料省略 `knowledge_level` 时默认使用 `unspecified`。正式输出统一保存这一枚举值，不使用 `null`、空字符串或 `aware` 代替未知；提案审核、快照和索引保留同一语义。已有三个程度值保持兼容。

知识水平不等于 AI 提取置信度。用户水平只能通过正式记录表达；`confidence` 只存在于证据或提案中。

### 7.3 兴趣水平

`interest_level` 使用：

- `high`
- `medium`
- `low`
- `unspecified`

没有可靠信息时必须使用 `unspecified`，不能根据出现次数静默推断。

### 7.4 Knowledge Node

`summary` 在知识点中表示“知识说明”：解释概念本身是什么、解决什么问题及其适用场景，不保存用户能力评价。`scope_note` 表示“掌握范围”；Markdown 正文表示“个人笔记”。材料的 `summary` 仍表示内容摘要。沿用字段名以兼容既有记录，旧内容由用户逐步修改，不自动改写。

示例：

```markdown
---
schema: ai-persona.knowledge-node/v1
id: kn_tebd_example
entity_type: knowledge_node
semantic_role: technique
title: TEBD
aliases:
  - Time-Evolving Block Decimation
  - 时间演化块消减
knowledge_level: proficient
interest_level: high
summary: TEBD 是基于张量网络的时间演化算法，常用于模拟一维量子多体系统的动力学。
scope_note: 掌握范围主要是实时演化和一维系统。
tags:
  - tag_physics
  - tag_tensor_network
evidence_refs:
  - ev_tebd_example
status: active
revision: 3
created_at: 2026-08-10T10:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# TEBD

## 个人笔记

目前主要用于一维量子系统的非平衡动力学研究。
```

`semantic_role` 第一版支持：

- `domain`
- `area`
- `topic`
- `concept`
- `theory`
- `model`
- `method`
- `technique`
- `tool`

`semantic_role` 只描述节点在语义上是什么，不决定它位于知识图的第几层。

### 7.5 Course

示例：

```yaml
schema: ai-persona.course/v1
id: crs_quantum_mechanics_example
entity_type: course
title: 量子力学
aliases:
  - Quantum Mechanics
knowledge_level: proficient
interest_level: high
description: 系统介绍量子力学的主要理论和计算方法。
syllabus: |-
  第一章 波函数与薛定谔方程
  第二章 角动量
  第三章 微扰理论
tags:
  - tag_physics
status: active
revision: 1
```

`description`（课程简介）和 `syllabus`（课程大纲）都是可选字符串，省略时默认为空字符串。课程覆盖的知识概念仍使用 `covers` 关系表达，不把全部概念复制进课程文件。

### 7.6 Material

`material_type` 支持：

- `article`
- `note`
- `paper`
- `book`
- `course_material`
- `conversation`
- `resume`
- `other`

示例：

```yaml
schema: ai-persona.material/v2
id: mat_measurement_transition_example
entity_type: material
material_type: paper
title: Measurement-Induced Phase Transitions
aliases: []
bibliography:
  authors:
    - Example Author
  published_at: '2026'
  venue: Example Journal
  language: en
  identifiers:
    arxiv: 2608.12345
    doi: null
    isbn: null
  canonical_url: https://arxiv.org/abs/2608.12345
user_relationships:
  - read
knowledge_level: familiar
preference_level: favorite
preference_reasons:
  - aspect: research-direction
    note: 该论文的问题与我关注的方向直接相关。
source_ref: src_paper_example
summary: 用户阅读过该论文，并熟悉其主要问题和结论。
scope_note: 熟悉文章的主要结论，尚未复现全部数值计算。
tags:
  - tag_quantum_dynamics
evidence_refs:
  - ev_paper_example
status: active
revision: 1
```

`user_relationships` 支持：

- `authored`
- `studied`
- `read`
- `skimmed`

阅读关系、理解程度和喜欢程度独立保存。详细字段和约束见
[`AI_PERSONA_MATERIAL_DESIGN.zh-CN.md`](./AI_PERSONA_MATERIAL_DESIGN.zh-CN.md)。

“材料讨论某概念”与“用户掌握某概念”是不同记录。材料出现一个高级概念，只能形成 `covers` 候选，不能直接提升对应知识节点的水平。

## 8. 知识图与关系

### 8.1 为什么使用图

知识不是严格的树。同一方法可以用于多个领域，同一概念可以有多个前置知识，同一材料可以同时讨论多个方向。因此正式模型使用允许多父节点的有向图。

### 8.2 文件路径不表达层级

不采用：

```text
物理学/量子物理/量子信息/张量网络/TEBD.md
```

采用平坦、稳定的对象文件：

```text
records/knowledge-nodes/kn_....md
records/knowledge-nodes/kn_....md
```

层级和应用关系由独立 Relation 对象表达。知识分类变化不会导致 ID、路径或引用整体重写。

### 8.3 Relation 对象

示例：

```markdown
---
schema: ai-persona.relation/v2
id: rel_tebd_tensor_network_example
entity_type: relation
source_id: kn_tensor_network_example
relation_type: broader_than
target_id: kn_tebd_example
evidence_refs:
  - ev_tebd_example
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# Tensor Network is broader than TEBD
```

关系方向必须唯一、明确。当前正式保存：

| `relation_type` | 方向语义 | 示例 |
|---|---|---|
| `broader_than` | source 是较宽概念，target 是较窄概念 | 张量网络方法 → TEBD |
| `part_of` | source 是组成部分，target 是整体 | 反向传播 → 训练流程 |
| `applied_in` | source 是方法/技术，target 是应用领域或问题 | TEBD → 非平衡动力学 |
| `requires` | source 依赖 target | TEBD → MPS |
| `related_to` | source 与 target 对称相关 | 拓扑序 ↔ 量子纠错 |
| `covers` | source 是课程/材料，target 是被讨论知识节点 | 量子力学课程 → 微扰理论 |

不同时保存 `broader_than` 和 `narrower_than` 两条反向边。`narrower_than` 是查询和人类视图中的派生表达。

### 8.4 图约束

- `broader_than` 子图必须无环；
- 普通关系的 source、relation type、target 不能重复；Material `covers` 关系还将 `knowledge_role` 纳入唯一键；
- `related_to` 使用规范化 ID 顺序保存，避免重复反向边；
- source 和 target 必须引用存在的正式对象；
- archived 对象的关系保留，但默认不进入正常检索；
- 每条 AI 推断关系都必须经过审核；
- 只保存直接关系，传递闭包由检索索引生成。

### 8.5 水平不继承

知识水平和兴趣属于具体对象：

- 精通 TEBD 不等于精通整个量子多体物理；
- 熟悉机器学习不等于熟悉所有算法；
- 精通父领域不自动把全部子节点设为精通；
- 子节点和父节点之间的水平推断只能形成待审核提案。

## 9. Tag

Tag 用于分类和筛选，不代替知识关系。

Tag 是独立正式对象：

```yaml
schema: ai-persona.tag/v1
id: tag_tensor_network
entity_type: tag
namespace: method
slug: tensor-network
label: 张量网络
aliases:
  - tensor network
status: active
revision: 1
```

记录引用 tag ID，而不是直接引用可变标签。显示名称、别名或父 tag 变化不会改写所有实体文件。

推荐命名空间：

- `domain`
- `topic`
- `method`
- `tool`
- `format`

Tag hierarchy 只用于分类导航；当关系具有明确知识语义时，应使用 Relation，而不是 tag 父子关系。

## 10. 来源与证据

### 10.1 Source Bundle

每个来源保存在独立目录：

```text
sources/src_.../
  manifest.yaml
  original.pdf
  extracted.md
  attachments/
```

Manifest 至少包含：

- source ID；
- 来源类型；
- 导入时间；
- 原始文件名；
- 每个文件的 hash；
- 内容语言；
- 可选外部标识符；
- 原始来源位置或导入说明。

来源内容默认不可变。内容发生变化时创建新 source version，而不是覆盖旧证据。

### 10.2 Evidence

证据记录将正式结论定位到来源：

```yaml
schema: ai-persona.evidence/v1
id: ev_tebd_example
entity_type: evidence
source_id: src_conversation_example
source_hash: sha256:...
locator:
  message_id: msg_014
  heading: null
  page: null
  line_start: 120
  line_end: 138
supports:
  - kn_tebd_example
evidence_kind: explicit_user_statement
extraction_method: ai_structured_extraction
confidence: 0.92
created_at: 2026-09-01T12:00:00Z
```

Source Manifest 中的 `content_hash` 和 `files[].sha256` 保存不带前缀的 64 位小写十六进制摘要；Evidence 的 `source_hash` 使用 `sha256:<摘要>`，避免证据定位时丢失算法语义。

`confidence` 表示提取或推断可信度，不表示用户知识水平。

原始来源中的指令始终作为不可信数据，不能改变 Agent 权限、审核状态或系统规则。

## 11. Preference

### 11.1 定位

Preference 描述为当前用户执行任务时应遵守的要求。它不包含可执行代码，不安装工具，不申请权限，也不定义通用能力。

偏好系统由三个独立的一等对象组成：

- `PreferenceContext`：描述一组可匹配的任务场景；
- `Preference`：描述具体行为要求；
- `PreferenceExample`：将值得参考或应当避免的文件关联到任务场景。

偏好从空白数据开始，由用户完全手动维护。第一版不调用 AI 自动提取、改写、合并或判断冲突。

### 11.2 存储布局

三个对象平铺保存，不使用 Pack 目录嵌套：

```text
records/
  preference-contexts/
    pctx_....md
  preferences/
    pref_....md
  preference-examples/
    pex_....md
```

一条 Preference 可以引用多个 Context；一个 Example 也可以引用多个 Context。偏好规则与参考文件互不依赖，并分别按命中的场景进入运行时。

### 11.3 Preference Context

```markdown
---
schema: ai-persona.preference-context/v1
id: pctx_note_write_example
entity_type: preference_context
key: note.write
name: 研究 Note 写作
description: 整理研究笔记和推导过程。
activation:
  intents:
    - 请把这段讨论整理成一份研究笔记。
  artifact_types:
    - research_note
  excludes: []
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---
```

`key` 是 API 和 Agent 使用的稳定标识。名称、描述和 activation 可以修改；key 创建后保持稳定。Context 可以归档，但仍被未归档 Preference 或 PreferenceExample 使用时必须先解除引用。

`description` 说明场景在什么时候使用，包括适用任务和范围。界面中的“典型请求示例”列举用户希望触发该场景的请求，每行一个；它们是语义正例，不是触发关键词或穷举清单。为兼容已有记录，示例继续保存在 `activation.intents`，不迁移或改写用户已有内容。模型结合描述、请求示例和排除条件判断，同义表达可以命中，示例为空时仍可根据描述判断。只读检索不根据请求示例做字符串匹配；自由文本任务先调用语义判定，再使用命中的 `context_key` 读取偏好。

### 11.4 Preference

```markdown
---
schema: ai-persona.preference/v1
id: pref_explain_formula_example
entity_type: preference
scope: contexts
context_refs:
  - pctx_note_write_example
behavior: required
instruction: 解释重要符号的物理意义，并说明公式在当前论证中的作用。
condition: 内容包含关键公式时
rationale: 以后重新阅读时不依赖原始论文。
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---
```

`behavior` 使用：

- `required`：必须遵守；
- `preferred`：应尽量遵守；
- `avoid`：应避免。

`scope: global` 表示所有任务，且 `context_refs` 必须为空；`scope: contexts` 必须引用至少一个未归档 Context。Preference 支持 `active`、`paused` 和 `archived`。只有 active 内容进入运行时。

### 11.5 Preference Example

```markdown
---
schema: ai-persona.preference-example/v3
id: pex_note_positive_example
entity_type: preference_example
context_refs:
  - pctx_note_write_example
example_type: positive
title: 先给推导路线的研究笔记
condition: 多步公式推导
reasons:
  - 读者先看到整体结构
source_ref: src_note_positive_example
content_hash: sha256:0000000000000000000000000000000000000000000000000000000000000000
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---
```

样本支持 `positive` 与 `negative`，记录正文必须为空。一个样本至少关联一个未归档 Context，可同时关联多个场景。`source_ref` 指向不可变 Source Bundle，`content_hash` 必须与 Source Manifest 一致。样本同样支持暂停和归档。

文件夹上传沿用上述样本与 Source schema：`origin.provider` 为 `preference-example-folder-upload`，`origin.identifier` 保存上传的根文件夹名称，`canonical_file` 为 `original.zip`，包含根文件夹及其全部已上传文件。ZIP 使用固定时间与排序，确保同一内容产生一致的快照 hash；样本 `content_hash` 与该 ZIP 的 hash 一致。另将每个成员按 `files/<根文件夹>/<相对路径>` 保存，并以 `attachment` 角色和各自 SHA-256 登记在 `files` 清单，供人工目录浏览、打开与复制路径使用。继续满足“恰好一个 original，canonical_file 为 original”的约束，不改变已有单文件 Source。上传失败不发布部分 Source 或样本，目录内的文本按纯文本打开，其他不支持预览的格式提供下载。此阶段不扩展 AI 的目录选择与读取流程。

### 11.6 编译与运行时

系统生成：

```text
generated/preferences/global.md
generated/preferences/<context-key>.md
```

`global.md` 只在存在 active 全局偏好时生成。每个场景文件合并全局偏好与命中该场景的偏好，按 required、preferred、avoid 排序，并附上该场景的 active 样本文件引用和最终检查清单。场景只有样本而没有偏好时仍生成场景文件。生成文件不可手工修改，相同输入必须产生相同内容。

运行时接收 `context_key`：

```text
读取全部 active 全局偏好
  → 查找 context_key 对应的 active Context
  → 合并引用该 Context 的 active Preference
  → 选择直接引用该 Context 的 active Example 文件
  → 返回 Preference Context
```

没有命中场景时，全局偏好仍然生效。paused 和 archived 对象不会进入快照、索引或运行时结果。

## 12. Change Proposal 与审核

### 12.1 Proposal 是唯一 AI 写入口

AI 不能直接写入 `records`。AI 提取、冲突修复和偏好学习统一产生 Change Proposal。

Proposal 操作第一版支持：

- `create`
- `update`
- `archive`
- `merge`
- `split`
- `relate`
- `unrelate`

### 12.2 结构化格式

Proposal 建议使用 JSON 作为机器事实，并生成 Markdown 审核视图：

```text
proposals/pending/prop_....json
generated/human/review/prop_....md
```

更新提案至少包含：

- proposal ID；
- 操作类型；
- 目标 ID；
- `base_revision` 和 base hash；
- 结构化 patch 或完整候选对象；
- 自然语言理由；
- evidence refs；
- confidence；
- 冲突和重复候选；
- 提交者与创建时间；
- proposal revision。

### 12.3 状态机

```text
draft
  → pending_review
      → accepted
      → edited_and_accepted
      → rejected
      → deferred
      → stale
```

当目标对象已经离开 `base_revision` 时，Proposal 必须进入 `stale`，不能静默覆盖新版本。

### 12.4 人工编辑

```text
用户提交修改
  → schema 校验
  → AI/规则进行格式规范化、去重和冲突分析
  → 无语义变化的规范化可以自动应用
  → 语义改写或冲突返回用户确认
  → 用户决定后发布正式 revision
```

AI 是校验和整理助手，不是用户自我描述的最终权威。

## 13. Revision 与发布

### 13.1 两级 revision

系统同时维护：

1. **对象 revision**：单个对象每次语义变化递增；
2. **persona revision**：一次审核批次成功发布后全局递增。

一个批次可以修改多个对象，但只产生一个新的 `persona_revision`。

### 13.2 Revision 日志

`revisions/changes.jsonl` 每行保存一个已发布批次：

```json
{
  "persona_revision": 42,
  "published_at": "2026-09-01T12:00:00Z",
  "actor": "human",
  "proposal_ids": ["prop_..."],
  "changes": [
    {
      "object_id": "kn_...",
      "old_revision": 2,
      "new_revision": 3,
      "old_hash": "sha256:...",
      "new_hash": "sha256:..."
    }
  ]
}
```

日志追加写，禁止原地修改旧行。

### 13.3 原子发布

发布顺序：

1. 在 staging 中生成修改后的正式记录；
2. 校验所有 schema、引用和图约束；
3. 编译 AI 快照、人类视图、Preference 运行时投影和临时索引；
4. 验证生成结果与引用完整性；
5. 原子替换正式记录和生成投影；
6. 追加 revision 日志并发布新的全局 revision；
7. 失败时恢复到发布前状态。

不得出现正式记录已更新、快照仍是旧版本的可见中间状态。

## 14. AI 快照

### 14.1 完整快照

生成：

```text
generated/persona.snapshot.json
```

快照只包含 active、已审核对象：

```json
{
  "schema_version": "ai-persona.snapshot/v1",
  "persona_revision": 42,
  "generated_at": "2026-09-01T12:00:00Z",
  "content_hash": "sha256:...",
  "knowledge_nodes": [],
  "courses": [],
  "materials": [],
  "relations": [],
  "tags": [],
  "preference_contexts": [],
  "preferences": [],
  "preference_examples": []
}
```

要求：

- 确定性排序；
- 明确 schema version；
- 不包含 pending proposal；
- 不无边界内嵌来源全文；
- Preference Example 保存关联、说明和用户直接录入的样本正文；
- 可完全从正式记录重建；
- schema 不兼容时显式迁移或拒绝读取。

### 14.2 任务上下文

完整快照用于导出、调试、备份和接口回退。Agent 日常使用：

```text
prepare_persona_context(task, question, max_chars)
```

结果包含：

- 直接匹配的知识实体；
- 必要祖先和前置知识；
- 相关方法或技术；
- 用户的知识水平和兴趣；
- 全局偏好、命中的 Preference Context、偏好和关联样本；
- 明确未知项；
- `persona_revision`；
- 每项被选择的原因。

## 15. 人类视图

### 15.1 正式对象可直接阅读

正式 Markdown 文件本身可在 Obsidian、VS Code 或普通编辑器中阅读。

### 15.2 生成导航

系统额外生成：

- 知识树；
- 多父节点知识图视图；
- 按精通、熟悉和了解分类的页面；
- 按兴趣和 tag 分类的页面；
- 课程、材料和关系详情；
- 偏好场景、偏好与参考样本视图；
- pending review、冲突和近期变更页面。

生成页面不可直接编辑。编辑动作必须回到正式对象或转换成结构化 Change Proposal。

### 15.3 审核界面

第一版可以使用 Markdown diff + CLI 操作：

- 接受；
- 编辑后接受；
- 拒绝；
- 暂缓；
- 合并重复提案。

后续本地 Web UI 读取相同 Proposal 服务，不能创建另一套状态逻辑。

## 16. 检索索引

SQLite 是可重建投影，不是真实数据来源。建议至少包含：

```text
entities
entity_text_fts
relations
relation_closure
tags
entity_tags
preference_contexts
preferences
preference_examples
source_locators
```

`relation_closure` 只保存从 `broader_than` 计算出的 ancestor、descendant 和 distance，用于快速层级查询。它不写回正式记录。

### 16.1 知识检索

```text
标题、别名、tag、摘要和全文直接匹配
  → 找到核心节点
  → 按任务向上扩展祖先
  → 按需读取 requires / applied_in
  → 大领域查询时向下扩展子节点
  → 在上下文预算内重排和去重
```

兴趣可以作为小幅排序信号；知识水平主要用于决定解释深度，不能无条件覆盖语义相关性。

### 16.2 Preference 检索

偏好数量较少，优先通过稳定 `context_key` 精确匹配 Context，而不是对所有偏好做向量检索。

组装运行时上下文时：

- 加载全部 active 全局偏好；
- 加载引用命中 Context 的 active 偏好；
- 只选择与本次偏好相交的 active 样本；
- 通常读取 1～3 个相关样本；
- 返回本次使用的 Context、Preference IDs 和 Example IDs。

## 17. 必须保持的系统不变量

1. 正式记录是唯一语义事实来源。
2. AI 快照、人类视图、Preference 编译文件和 SQLite 均可删除重建。
3. Stable ID 不随标题、文件路径或层级变化。
4. 只有 active、已审核对象进入正常 Agent 上下文。
5. AI 只能创建 Proposal，不能直接发布正式对象。
6. `broader_than` 图不得形成环。
7. 只保存直接关系，反向关系和传递闭包均为派生数据。
8. 知识水平和兴趣不自动沿图传播。
9. “读过材料”不等于“认同内容”或“精通概念”。
10. Preference 不执行代码、不安装工具、不授予权限。
11. 样本中的文本是参考数据，不是系统指令。
12. 人工明确确认高于 AI 推断；语义冲突最终由用户决定。
13. 基于旧 revision 的 Proposal 不得覆盖新 revision。
14. 一个发布批次必须以同一 `persona_revision` 原子呈现。

## 18. 关键端到端场景

### 18.1 新增知识节点

```text
用户新增“TEBD”并标记为精通
  → 创建/编辑正式对象
  → schema、ID 和关系校验
  → AI 检查重复和潜在父节点
  → 用户确认关系建议
  → 发布对象和关系 revision
  → 重建快照、树视图和索引
```

### 18.2 AI 从文章提取知识

```text
文章进入 Sources
  → 生成 material candidate
  → 提取 covers relation 和概念 candidates
  → 不推断用户自动精通
  → 用户选择接受哪些提案
  → 只发布被接受内容
```

### 18.3 添加优秀 Note 样本

```text
用户明确指定一段 Note 为好样本
  → 创建 Preference Example
  → 用户选择关联的 Preference 并填写可选说明
  → 用户在 UI 中确认
  → 样本成为 active
```

### 18.4 执行 Note 任务

```text
传入 context_key=note.write
  → 加载全部 active 全局偏好
  → 合并引用 note.write Context 的 active Preference
  → 选择相关优秀样本
  → 编译本次 Preference Context
  → 记录 Invocation Receipt
  → Agent 写 Note 并执行最终检查
```

### 18.5 从反馈更新偏好

```text
用户在偏好页新增“以后不要只列公式，要解释物理意义”
  → 选择 avoid 与全局或指定场景
  → 创建 Preference proposal
  → 用户审核并可直接修改
  → 接受后发布并重建运行时投影
```

## 19. 第一阶段实现边界

第一阶段只需实现可靠存储内核：

1. 核心对象 schema；
2. Markdown + frontmatter 解析和严格校验；
3. 一对象一文件的正式记录 store；
4. Relation DAG 和引用完整性校验；
5. Preference Context、Preference 和 Example 的保存与静态编译；
6. 全局和对象 revision；
7. `persona.snapshot.json` 编译；
8. 基础 Markdown 人类视图；
9. 从正式记录完全重建生成投影的测试。

第一阶段不需要 LLM、embedding、自动 watcher 或完整 Web UI。只有存储、校验和编译内核稳定后，才加入 AI 提取和自动更新。

## 20. 待确认项

以下决定不改变本文的核心存储结构，但应在实现前确认：

1. ID 最终选择带前缀 UUIDv4、UUIDv7 还是 ULID；
2. 第一版人工审核使用 Obsidian + CLI，还是直接开发本地 Web UI；
3. 正文 `human_notes` 是否默认进入 AI 快照，还是只进入全文索引；
4. 是否需要独立 `ProfileFact` 保存简历中的职位、经历和个人事实；
5. Preference Context 是否需要项目级 overlay；
6. Invocation Receipt 的默认保留时间和隐私策略；
7. AI 提取是否必须本地运行，还是允许用户配置远程模型。
