# AI 电子人格：Material v0.3 存储与人工维护设计

> 设计与历史参考：本文可能包含早期阶段或规划，不是本次发行的验收报告。当前入口与能力以[使用指南](../../../docs/GETTING_STARTED.zh-CN.md)和[兼容矩阵](../../../docs/FEATURE_PARITY.md)为准。

| 字段 | 内容 |
|---|---|
| 文档状态 | 已实现 |
| 版本 | 0.3 |
| 日期 | 2026-09-02 |
| 适用项目 | AI Persona |
| 关联需求 | [AI_PERSONA_PRD.zh-CN.md](./AI_PERSONA_PRD.zh-CN.md) |
| 关联存储设计 | [AI_PERSONA_STORAGE_DESIGN.zh-CN.md](./AI_PERSONA_STORAGE_DESIGN.zh-CN.md) |
| 前置实现 | [AI_PERSONA_MANUAL_MAINTENANCE_DESIGN.zh-CN.md](./AI_PERSONA_MANUAL_MAINTENANCE_DESIGN.zh-CN.md) |

## 1. 文档目的

本文档定义 AI Persona 中 `Material` 的第二阶段设计，重点解决以下问题：

1. 用户读过的文章、论文、Note、书籍等材料如何正式保存；
2. 原文、用户评价和知识关系如何分离；
3. Material 如何表达用户对材料的理解程度和喜欢程度；
4. Material 如何通过 Tag 和 Knowledge Graph 进行组织；
5. Material–Knowledge Relation 如何保存、校验和展示；
6. 人类如何通过 UI 阅读、新增、修改和归档 Material；
7. 所有正式修改如何继续经过 Proposal 和人工审核。

本文档取代 v0.2 中“Material 只读、结构暂缓”的临时约定，但不改变 Knowledge、Course 和 Preference 的既有设计。

## 2. 范围

### 2.1 本阶段包含

| 能力 | 本阶段设计 |
|---|---|
| Material 正式模型 | 定义 `material/v2` |
| Material 类型 | paper、article、note、book 等 |
| 原文保存 | 使用不可变 Source Bundle |
| 用户关系 | 记录 authored、studied、read、skimmed |
| 理解程度 | proficient、familiar、aware、unspecified（未设置） |
| 喜欢程度 | favorite、liked、neutral、disliked、unspecified |
| 喜欢原因 | 按 topic、method、style 等方面保存 |
| 组织方式 | Tag 加 Material–Knowledge Relation |
| Material–Knowledge Relation | 角色、重要程度、解释和证据 |
| UI 阅读 | 列表、详情、知识联系和原文视图 |
| 人工维护 | 导入、新建、修改、归档和关系维护 |
| 审核 | 所有正式变化通过 Proposal |
| 历史 | revision、审计记录和不可变 Source |

### 2.2 本阶段不包含

- Agent 调用接口；
- arXiv 定时任务；
- 每日论文候选池；
- 论文推荐和排序算法；
- 向量检索和 Embedding 模型选择；
- 自动生成研究方向；
- AI 自动接受 Material 或知识关系；
- 待阅读列表和稍后阅读功能；
- 多用户权限和云端同步；
- Material–Material 的引用、扩展和冲突关系；
- 永久删除已发布的 Material 或 Source。

这些能力可以使用本设计保存的正式数据，但不属于本阶段的实现范围。

## 3. Material 的定义

Material 表示：

> 一份用户已经读过，并确认值得进入 AI Persona 的材料，以及用户与这份材料之间的关系、理解程度、偏好判断和个人备注。

以下内容可以成为 Material：

- 用户读过或研究过的论文；
- 用户阅读过的文章；
- 用户写过或维护的 Note；
- 用户读过的书；
- 用户参与撰写的论文或文章；
- 用户确认需要长期保留的对话或课程材料；
- 其他能够代表用户知识储备或偏好的文本材料。

以下内容不直接成为 Material：

- 尚未阅读的收藏；
- 自动抓取但未经过筛选的候选论文；
- 仅供一次任务使用的临时网页；
- AI 尚未经过人工确认的推断；
- 只有 URL、但没有保存原文快照的链接。

## 4. 核心对象边界

Material 相关数据分为三个正式层次：

```text
Material
  用户对材料的长期认知、评价和备注

Source
  不可变的原文、提取文本、来源和文件 Hash

Relation / Evidence
  Material 与 Knowledge Node 的联系，以及联系在原文中的依据
```

### 4.1 Material 负责保存

- 稳定 ID；
- 材料类型；
- 规范化书目信息；
- 用户与材料的关系；
- 用户理解程度；
- 用户喜欢程度及原因；
- 经人工确认的摘要和阅读边界；
- Tag；
- Source 引用；
- 状态、revision 和时间；
- 人类维护的个人笔记。

### 4.2 Source 负责保存

- 原始 PDF、Markdown、HTML、TXT 或其他文件；
- 从原文提取的 Markdown 或纯文本；
- 来源 URL、外部标识符和版本；
- 抓取或导入时间；
- 文件类型和文件角色；
- 每个文件的 SHA-256；
- 整个来源内容的稳定 Hash；
- 提取器及其版本。

### 4.3 Relation 负责保存

- Material 与 Knowledge Node 的直接联系；
- 知识在材料中的角色；
- 该联系的重要程度；
- 人类可读的关系说明；
- 指向原文位置的 Evidence。

### 4.4 Material 正文负责保存

- 为什么保存；
- 主要收获；
- 与个人研究或工作的联系；
- 开放问题；
- 可能的后续方向；
- 其他不适合放入结构化字段的个人笔记。

原文不得复制到 Material 正文中。Material 正文也不得代替 Source。

## 5. 设计原则

### 5.1 正式 Material 必须对应原文

每个 active Material 必须有有效的 `source_ref`。通过链接导入时，系统必须保存原文快照，而不是只保存 URL。

### 5.2 原文不可变

已进入正式 Source Bundle 的原始文件不允许覆盖。原文或 arXiv 版本发生变化时，创建新的 Source，并通过 Proposal 修改 Material 的 `source_ref`。

### 5.3 理解程度与喜欢程度分离

用户可能非常理解一篇并不喜欢的论文，也可能很喜欢一篇暂时只读懂部分内容的论文。这两个维度必须独立保存。

### 5.4 Material 与 Knowledge Node 的水平分离

Material 的 `knowledge_level` 只表示用户对该材料的理解程度。Material 涉及某个 Knowledge Node，不会自动改变用户对该知识的掌握水平。

### 5.5 文件路径不表达领域

Material 文件按稳定 ID 扁平保存。领域由 Material–Knowledge Relation 和知识图推导；Tag 只用于灵活筛选。

### 5.6 只保存直接语义关系

只保存材料明确讨论、使用或依赖的 Knowledge Node。通过 Knowledge Graph 能够推导出的祖先领域不重复写入正式关系。

### 5.7 正式修改必须经过 Proposal

UI 不直接修改正式 Material、Relation 或 Evidence。人工操作和未来 AI 建议使用同一套 Proposal、校验、审核和发布流程。

### 5.8 归档优先于删除

已发布 Material 和关系只能归档。归档后退出正常列表和索引，但保留稳定 ID、Source、历史和审计记录。

## 6. 目录结构

```text
persona-data/
  records/
    materials/
      mat_....md

    relations/
      rel_....md

    evidence/
      ev_....md

    tags/
      tag_....md

  sources/
    src_..../
      manifest.yaml
      original.pdf
      extracted.md
      attachments/

  proposals/
    pending/
    history/

  generated/
    human/
      materials.md
      materials/
        mat_....md
    persona.snapshot.json
```

约束：

- `records/materials/` 不按领域创建子目录；
- 一个 Material 文件只保存一个正式 Material；
- Source 目录名使用稳定 Source ID；
- Relation 和 Evidence 独立保存；
- `generated/` 只包含可重建投影，不是正式事实来源。

## 7. Material v2 模型

### 7.1 模型独立性

`Material` 不再继承通用 `KnowledgeRecord`，而是直接继承 `BaseRecord`，显式声明 Material 特有字段。

这样可以避免把 Knowledge Node 的兴趣、范围和证据语义强行复用于 Material。

### 7.2 字段总览

| 字段 | 类型 | 必填 | 含义 |
|---|---|---:|---|
| `schema` | string | 是 | `ai-persona.material/v2` |
| `id` | string | 是 | `mat_` 开头的稳定 ID |
| `entity_type` | string | 是 | 固定为 `material` |
| `material_type` | enum | 是 | 材料类型 |
| `title` | string | 是 | 标题 |
| `aliases` | string[] | 否 | 别名、译名或缩写 |
| `bibliography` | object | 是 | 规范化书目信息 |
| `user_relationships` | enum[] | 是 | 用户与材料的关系 |
| `knowledge_level` | enum | 否 | 用户对材料的理解程度，默认 `unspecified` |
| `preference_level` | enum | 是 | 用户对材料的喜欢程度 |
| `preference_reasons` | object[] | 否 | 喜欢或不喜欢的具体原因 |
| `summary` | string | 否 | 经人工确认的内容概述 |
| `scope_note` | string/null | 否 | 阅读和理解边界 |
| `tags` | string[] | 否 | Tag ID |
| `source_ref` | string | 是 | 当前正式 Source ID |
| `evidence_refs` | string[] | 否 | 支持用户状态或评价的 Evidence |
| `status` | enum | 是 | `active` 或 `archived` |
| `revision` | integer | 是 | 对象 revision |
| `created_at` | datetime | 是 | 首次发布时间 |
| `updated_at` | datetime | 是 | 最近发布时间 |

### 7.3 Material 类型

第一版支持：

- `paper`
- `article`
- `note`
- `book`
- `course_material`
- `conversation`
- `resume`
- `other`

Material 类型描述材料是什么，不表达用户是否喜欢或是否读过。

### 7.4 书目信息

```yaml
bibliography:
  authors:
    - Author A
    - Author B
  published_at: 2026-08-30
  venue: arXiv
  language: en
  identifiers:
    arxiv: "2608.12345"
    doi: null
    isbn: null
  canonical_url: https://arxiv.org/abs/2608.12345
```

规则：

- `authors` 保留显示顺序；
- `published_at` 允许只有年份或完整日期，由 Schema 使用可空结构表达；
- `identifiers` 只保存规范化外部标识符；
- DOI 和 arXiv ID 在 active Material 中必须唯一；
- `canonical_url` 是来源定位信息，不代替 Source；
- 不适用的字段使用 `null`，不使用空字符串伪装缺失值。

### 7.5 用户关系

```yaml
user_relationships:
  - authored
  - studied
```

第一版支持：

- `authored`
- `studied`
- `read`
- `skimmed`

阅读深度顺序为：

```text
skimmed < read < studied
```

约束：

- `skimmed`、`read` 和 `studied` 最多出现一个；
- `authored` 可以与其中任意一个同时存在；
- 非 authored Material 至少包含一个阅读关系；
- `saved` 不属于正式 Material，未来由独立待读功能处理。

### 7.6 理解程度

沿用统一机器值：

| 存储值 | UI 标签 | Material 中的含义 |
|---|---|---|
| `aware` | 了解 | 知道主要问题、方法或结论 |
| `familiar` | 熟悉 | 可以解释主要方法、结果和意义 |
| `proficient` | 精通 | 可以批判、复现、应用或延伸材料内容 |
| `unspecified` | 未设置 | 尚未填写理解程度，不代表不了解材料 |

UI 必须将字段显示为“理解程度”，避免用户误认为它表示材料本身的难度。

新建材料默认未设置理解程度；用户可以保持未设置状态审核通过，以后再补充，也可以将已填程度改回未设置。创建提案时省略该字段与显式传入 `unspecified` 等价。阅读关系的必填规则不因此改变。

阅读关系与理解程度不自动绑定。例如，用户可以完整读过一篇论文，但仍将理解程度标为 `aware`。

### 7.7 喜欢程度

Material 使用独立的 `preference_level`，不复用 Knowledge Node 的 `interest_level`。

| 存储值 | UI 标签 | 含义 |
|---|---|---|
| `favorite` | 非常喜欢 | 希望优先保留和参考类似材料 |
| `liked` | 喜欢 | 明确的正向偏好 |
| `neutral` | 一般 | 有价值，但没有明显偏好 |
| `disliked` | 不喜欢 | 明确的负向偏好 |
| `unspecified` | 未标注 | 尚无可靠判断 |

默认规则：

- 用户主动选择加入的外部材料，UI 默认 `liked`，但发布前必须可修改；
- authored Material 默认 `unspecified`；
- AI 不得仅因材料被多次检索就修改喜欢程度；
- `disliked` Material可以保留，用于记录负面偏好和知识储备。

### 7.8 偏好原因

```yaml
preference_reasons:
  - aspect: research-direction
    note: 与我关心的非平衡量子动力学直接相关
  - aspect: method
    note: 喜欢它将张量网络用于开放系统的方式
  - aspect: visualization
    note: 问题定义和图示非常清楚
```

`aspect` 第一版支持：

- `topic`
- `method`
- `result`
- `research-direction`
- `writing-style`
- `visualization`
- `practicality`
- `other`

规则：

- 每条原因必须包含非空 `note`；
- 原因可以是正面或负面，其方向由 `preference_level` 和文字共同表达；
- 偏好原因描述用户为什么喜欢或不喜欢，不代替 Material–Knowledge Relation；
- 写作和绘图方面的稳定任务要求仍应作为独立 Preference 保存，而不是只保存在 Material 中。

### 7.9 摘要与阅读边界

`summary` 表示经人工确认的材料内容概述；`scope_note` 表示用户的阅读或理解边界。

```yaml
summary: 研究测量对量子多体系统动力学和纠缠结构的影响。
scope_note: 理解了主要物理图像，但尚未检查全部数值细节。
```

原始 abstract 保存在 Source 或由 Source 投影展示，不写入 `summary` 冒充用户总结。

### 7.10 Tag

```yaml
tags:
  - tag_physics
  - tag_quantum_dynamics
  - tag_arxiv
```

Tag 适合表达：

- 来源：`arxiv`；
- 形式：`review`、`tutorial`；
- 特征：`open-source-code`；
- 临时组织：`important-reference`；
- 用户自定义集合。

Tag 不负责表达“材料使用了什么方法”或“材料研究什么问题”。这些语义由 Material–Knowledge Relation 表达。

### 7.11 完整 Material 示例

```markdown
---
schema: ai-persona.material/v2
id: mat_measurement_transition
entity_type: material
material_type: paper
title: Measurement-Induced Phase Transitions
aliases: []
bibliography:
  authors:
    - Author A
    - Author B
  published_at: 2026-08-30
  venue: arXiv
  language: en
  identifiers:
    arxiv: "2608.12345"
    doi: null
    isbn: null
  canonical_url: https://arxiv.org/abs/2608.12345
user_relationships:
  - read
knowledge_level: familiar
preference_level: favorite
preference_reasons:
  - aspect: research-direction
    note: 与我关心的非平衡量子动力学直接相关
  - aspect: method
    note: 数值方法可能用于现有研究
summary: 研究测量对量子多体系统动力学和纠缠结构的影响。
scope_note: 理解了主要物理图像，但尚未检查全部数值细节。
tags:
  - tag_physics
  - tag_quantum_dynamics
  - tag_arxiv
source_ref: src_arxiv_2608_12345_v1
evidence_refs:
  - ev_measurement_transition_read
status: active
revision: 1
created_at: 2026-09-02T12:00:00Z
updated_at: 2026-09-02T12:00:00Z
---

# Personal Notes

## Why I saved this

它把测量动力学和非平衡相变联系了起来。

## Key takeaways

- 测量会与幺正演化竞争。
- 纠缠结构可以随测量强度发生相变。

## Connections to my work

可能与当前使用张量网络研究实时演化的问题相关。

## Open questions

- TEBD 在这一问题上的主要数值限制是什么？
- 是否能与开放系统方法建立联系？

## Possible directions

- 在相同模型上比较不同实时演化算法。
```

正文标题是人类维护约定，不作为严格 Schema 字段。允许省略没有内容的章节。

## 8. Source Bundle v2

### 8.1 目录格式

```text
sources/src_arxiv_2608_12345_v1/
  manifest.yaml
  original.pdf
  extracted.md
  attachments/
```

### 8.2 Manifest 示例

```yaml
schema: ai-persona.source-manifest/v2
id: src_arxiv_2608_12345_v1
source_type: paper
imported_at: 2026-09-02T12:00:00Z
origin:
  provider: arxiv
  identifier: "2608.12345"
  version: v1
  url: https://arxiv.org/abs/2608.12345
  retrieved_at: 2026-09-02T11:50:00Z
canonical_file: original.pdf
content_hash: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
files:
  - path: original.pdf
    role: original
    media_type: application/pdf
    sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  - path: extracted.md
    role: extracted_text
    media_type: text/markdown
    sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
extraction:
  tool: example-extractor
  version: "1.0"
```

`content_hash` 和 `files[].sha256` 使用 64 位小写十六进制摘要，不带算法前缀；Evidence 的 `source_hash` 使用 `sha256:<摘要>`，用于显式标明定位所采用的算法。

### 8.3 Source 规则

- `canonical_file` 必须存在于 `files`；
- 至少有一个 `role: original` 的文件；
- 文件 Hash 必须与实际内容一致；
- Source 内容默认不可变；
- 新的外部版本创建新的 Source ID；
- 修改提取器时可以创建新的提取结果，但不得覆盖原始文件；
- `extracted.md` 必须标明它是提取结果，不能作为原始事实伪装成原文；
- Material 归档不会删除 Source；
- 没有任何正式记录引用的 Source 可以进入后续人工清理流程，但本阶段不自动删除。

## 9. Material–Knowledge Relation

### 9.1 方案选择

本设计不把知识引用嵌入 Material，也不为 `uses_method`、`studies_problem` 等含义创建大量 Relation Type。

统一使用：

```yaml
relation_type: covers
```

并增加：

- `knowledge_role`：知识在材料中扮演的角色；
- `salience`：该联系的重要程度；
- `statement`：人类可读的具体关系说明；
- `evidence_refs`：原文依据。

### 9.2 关系方向

方向固定为：

```text
Material → Knowledge Node
```

即：

```yaml
source_id: mat_...
target_id: kn_...
```

不同时保存反方向关系。Knowledge 页面通过反向查询显示关联 Material。

### 9.3 Relation 示例

```yaml
---
schema: ai-persona.relation/v2
id: rel_material_tebd_method
entity_type: relation
source_id: mat_measurement_transition
relation_type: covers
target_id: kn_tebd
knowledge_role: method
salience: primary
statement: 文章使用 TEBD 计算一维量子系统的实时演化。
evidence_refs:
  - ev_measurement_transition_tebd
status: active
revision: 1
created_at: 2026-09-02T12:00:00Z
updated_at: 2026-09-02T12:00:00Z
---
```

### 9.4 Knowledge Role

| 存储值 | UI 标签 | 含义 |
|---|---|---|
| `topic` | 研究主题 | 材料整体讨论的主题 |
| `problem` | 研究问题 | 材料试图解决的问题 |
| `method` | 使用方法 | 材料使用的方法或技术 |
| `theory` | 理论基础 | 材料依赖或讨论的理论 |
| `model` | 模型或系统 | 研究对象、模型或数据 |
| `application` | 应用方向 | 方法被用于的场景 |
| `result` | 主要结果 | 材料得到的重要概念性结论 |
| `background` | 背景知识 | 理解材料所需的背景 |
| `mentioned` | 一般提及 | 出现过但不构成主要内容 |

`KnowledgeNode.semantic_role` 表示知识本身是什么；`Relation.knowledge_role` 表示知识在当前材料中起什么作用。二者不得混为同一个字段。

### 9.5 Salience

| 存储值 | UI 标签 | 含义 |
|---|---|---|
| `primary` | 核心 | 材料的主要内容或主要方法 |
| `secondary` | 次要 | 对理解材料有实质作用，但不是核心 |
| `mentioned` | 仅提及 | 只在局部出现或作为引用背景 |

### 9.6 Statement

Material–Knowledge Relation 的 `statement` 必填，使用一句或少量几句自然语言说明具体联系。

有效示例：

```text
文章使用 TEBD 计算淬火后一维量子系统的实时演化。
```

无效示例：

```text
与 TEBD 相关。
```

`statement` 应说明“以什么方式相关”，不能只重复 Knowledge Node 名称。

### 9.7 多角色关系

同一个 Knowledge Node 在一份 Material 中可以承担多个角色。每个角色保存为独立 Relation。

例如：

```text
Material → 张量网络，knowledge_role = topic
Material → 张量网络，knowledge_role = method
```

这样可以分别维护说明、Evidence、状态和 revision。

active Material–Knowledge Relation 的唯一键为：

```text
source_id + target_id + relation_type + knowledge_role
```

### 9.8 直接关系与派生领域

若知识图中存在：

```text
量子多体物理 → 张量网络 → TEBD
```

Material 明确使用 TEBD 时，只保存：

```text
Material → TEBD
```

“该 Material 属于张量网络和量子多体物理”由知识图推导，不重复保存。

当 Material 本身确实以张量网络为研究主题时，可以另外保存：

```text
Material → 张量网络，knowledge_role = topic
```

### 9.9 Evidence 规则

- AI 提出的 Material–Knowledge Relation 必须附带 Evidence；
- 人工直接声明的关系可以不手动选择 Evidence，但必须填写 `statement`；
- 用户在 UI 中选择原文片段时，系统自动创建 Evidence；
- Evidence 必须引用当前或历史 Source 的具体 Hash；
- Source 更新不会使旧 Evidence 静默指向新内容；
- Evidence 缺失不等于关系无效，但 UI 应显示“未定位原文依据”。

### 9.10 不保存的内容

以下内容不进入正式 Relation：

- Embedding 相似度；
- 一次任务中的临时相关性分数；
- 可以通过 Knowledge Graph 推导出的全部祖先节点；
- 尚未审核的 AI 候选关系；
- 只有共同 Tag、但没有明确语义的关联；
- 自动生成且未经确认的研究方向。

## 10. 人类阅读 UI

### 10.1 Material 列表页

列表卡片或表格优先显示：

- 标题；
- Material 类型；
- 作者和发布时间；
- 用户关系；
- 理解程度；
- 喜欢程度；
- 最多两个核心主题；
- 最多两个核心方法；
- 少量 Tag；
- 是否有本地原文。

示例：

```text
Measurement-Induced Phase Transitions
Paper · Author A et al. · 2026

读过 · 熟悉 · 非常喜欢
主题：非平衡量子动力学、测量诱导相变
方法：张量网络、TEBD
另外 6 个知识联系
```

列表页不展示全部 Relation statement 和 Evidence，避免信息拥挤。

### 10.2 列表筛选

支持按以下维度筛选：

- Material 类型；
- 用户关系；
- 理解程度；
- 喜欢程度；
- Tag；
- 关联 Knowledge Node；
- 推导出的领域；
- Knowledge Role；
- Salience；
- active 或 archived。

“领域”不是 Material 直接字段，而是通过核心 Knowledge Node 的祖先路径推导。

### 10.3 Material 详情页

详情页按以下顺序展示：

1. 基本信息；
2. 我的阅读情况；
3. 我的评价；
4. 知识联系；
5. 个人笔记；
6. 原文与来源；
7. revision 和审核历史。

#### 基本信息

- 标题；
- 作者；
- 发布时间；
- 期刊或来源；
- DOI、arXiv ID、ISBN；
- Material 类型；
- Tag。

#### 我的阅读情况

- authored、studied、read 或 skimmed；
- 理解程度；
- 阅读和理解边界。

#### 我的评价

- 喜欢程度；
- 按方面分组的偏好原因；
- 为什么保存这份材料。

#### 个人笔记

按 Markdown 章节显示：

- Why I saved this；
- Key takeaways；
- Connections to my work；
- Open questions；
- Possible directions。

### 10.4 知识联系视图

知识联系默认使用分组列表，不默认使用图。

分组顺序：

1. 研究主题；
2. 研究问题；
3. 使用方法；
4. 理论基础；
5. 模型或系统；
6. 应用方向；
7. 主要结果；
8. 背景知识；
9. 一般提及。

每条关系显示：

- Knowledge Node 名称；
- Knowledge Role；
- Salience；
- Statement；
- 从领域到当前知识节点的路径；
- Evidence 状态；
- 查看原文依据；
- 编辑；
- 提出移除。

示例：

```text
使用方法

TEBD                                      核心
文章使用 TEBD 计算一维量子系统的实时演化。
物理学 / 量子物理 / 张量网络 / TEBD
[查看原文依据] [编辑] [提出移除]
```

### 10.5 关系图

Material 详情可以提供次级“关系图”Tab：

```text
知识联系 | 关系图
```

关系图只用于快速观察 Material 周围的一跳 Knowledge Node 和必要祖先，不作为主要编辑界面。

图中必须同时使用文字和视觉样式表示 Knowledge Role，不能只依赖颜色。

### 10.6 原文视图

原文区域提供：

- 打开原始文件；
- 阅读 extracted Markdown；
- 查看 Source Manifest；
- 查看文件 Hash；
- 查看来源 URL 和版本；
- 从原文选择一段内容作为 Evidence。

原文、提取文本和 Material 个人笔记必须有明确标签，避免用户误认为它们来自同一来源。

## 11. 新增 Material

### 11.1 导入方式

第一版提供三种入口：

1. 上传文件；
2. 粘贴原文；
3. 从 URL、arXiv ID 或 DOI 导入。

#### 上传文件

支持第一阶段必要格式：

- PDF；
- Markdown；
- TXT；
- HTML。

EPUB 和其他格式后续增加。

#### 粘贴原文

系统将用户粘贴的内容原样保存为 `original.md`，不得先由 AI 改写后再保存。

#### 链接导入

系统必须下载并保存原文快照。只保存 URL 的记录不能发布为 active Material。

### 11.2 新增流程

```text
选择原文
  → 创建 Source Bundle
  → 提取文本和书目信息
  → 检查重复
  → 填写用户关系和理解程度
  → 填写喜欢程度和原因
  → 选择 Tag
  → 添加 Material–Knowledge Relation
  → 预览
  → 生成 Proposal
  → 人工审核
  → 发布 Material 和相关记录
```

### 11.3 分步表单

#### 第一步：原文

- 上传文件、粘贴文本或输入链接；
- 显示文件类型、大小和 Hash；
- 显示是否成功生成 extracted Markdown；
- 检查重复 Source。

#### 第二步：基本信息

- 标题；
- 作者；
- 发布时间；
- 来源；
- DOI、arXiv ID 或 ISBN；
- Material 类型；
- 规范 URL。

#### 第三步：我的情况

- 用户关系；
- 理解程度；
- 喜欢程度；
- 偏好原因；
- 阅读边界；
- 摘要和个人笔记。

#### 第四步：组织和知识联系

- Tag；
- Knowledge Node；
- Knowledge Role；
- Salience；
- Statement；
- 可选原文 Evidence。

#### 第五步：审核预览

并排或分区显示：

- 原文预览；
- 即将发布的 Material；
- 即将新增的 Relation；
- 自动提取字段与人工填写字段；
- 重复和冲突警告。

### 11.4 去重

新增前依次检查：

1. 相同 DOI；
2. 相同 arXiv ID 和版本；
3. 相同 ISBN；
4. 相同 Source content hash；
5. 高相似标题、作者和年份。

前四项形成确定性阻止或强冲突。第五项形成重复候选警告，由人类决定。

## 12. Material–Knowledge Relation 维护

### 12.1 新增关系

在 Material 详情页提供“添加知识联系”。用户可以一次增加多行，每行分别完成：

1. 搜索并选择 Knowledge Node；
2. 选择 Knowledge Role；
3. 选择 Salience；
4. 填写 Statement；
5. 可选选择原文依据；
6. 提交 Relation Proposal。

整批内容先统一校验，任一行无效时不生成任何提案；校验通过后，每行生成一条可独立审核的 Relation Proposal。批次级备注和原文依据应用于本次提交的全部关系。

如果找不到 Knowledge Node，UI 提供“提出创建新的知识概念”，但不允许把自由文本直接保存为关系目标。

### 12.2 编辑关系

以下字段可以通过 `update Relation Proposal` 修改：

- `knowledge_role`；
- `salience`；
- `statement`；
- `evidence_refs`。

不允许直接修改 `source_id` 或 `target_id` 来改变关系端点。改变端点时应归档旧关系并创建新关系。

### 12.3 移除关系

移除使用 `unrelate` 或 `archive Relation Proposal`，接受后将关系状态设为 `archived`，不永久删除文件。

### 12.4 重复和层级提示

- 相同唯一键的 active Relation 必须拒绝；
- 同一 Material–Knowledge 可以使用不同 Knowledge Role；
- 当用户同时关联父节点和子节点时，UI 给出提示，但不一律阻止；
- 如果父节点关系只是由子节点层级推导，默认建议不保存；
- archived Relation 不阻止以后重新建立新的 active Relation，但历史必须可追踪。

### 12.5 AI 建议的预留显示

UI 预留两个区域：

```text
已确认的知识联系
待审核的建议联系
```

建议联系始终显示为 Proposal，不得混入正式关系列表。即使本阶段不实现自动提取，页面结构也不得假设所有关系都由人工直接创建。

## 13. 修改 Material

### 13.1 可修改字段

通过 `update Material Proposal` 修改：

- 标题和别名；
- 书目信息；
- 用户关系；
- 理解程度；
- 喜欢程度；
- 偏好原因；
- 摘要和阅读边界；
- Tag；
- Source 引用；
- Material 正文。

### 13.2 Source 更新

更新原文时：

1. 创建新 Source Bundle；
2. 验证新 Source；
3. 生成修改 `source_ref` 的 Material Proposal；
4. 显示新旧 Source 版本和 Hash；
5. 接受后更新 Material revision；
6. 旧 Source 和旧 Evidence 保留。

不得覆盖原有 `original.*` 文件。

### 13.3 字段审核

审核页按逻辑分组显示 diff：

- 书目信息；
- 用户关系和理解程度；
- 偏好；
- 组织和 Tag；
- Source；
- 个人笔记。

机器提取字段必须标明来源，不能显示成用户已经确认的事实。

## 14. 归档

### 14.1 归档 Material

归档 Material 时：

- Material `status` 变为 `archived`；
- 与该 Material 相连的 active Material–Knowledge Relation 一并归档；
- Material 退出默认列表、搜索和生成上下文；
- Source、Evidence、revision 和 Proposal History 保留；
- 整个操作作为一次人格 revision 发布。

### 14.2 恢复

恢复已归档 Material 需要新的 Proposal。恢复时不自动恢复全部历史 Relation，用户应审核哪些关系仍然有效。

### 14.3 永久删除

本阶段不提供已发布 Material 和 Source 的永久删除。

尚未提交的本地导入草稿可以删除，但删除范围必须精确指向对应草稿和未引用 Source。

## 15. Proposal 与原子性

### 15.1 基本操作

Material 阶段需要支持：

- `create material`；
- `update material`；
- `archive material`；
- `create/relate material knowledge relation`；
- `update relation`；
- `unrelate/archive relation`。

### 15.2 创建时的多对象变化

一次 Material 导入可能产生：

- 一个 Source Bundle；
- 一个 Material；
- 多个 Relation；
- 多个 Evidence。

存储上这些对象保持独立；UI 上应作为一次“Material 导入”审核会话展示。

第一阶段可以使用共享 `change_set_id` 将多个 Proposal 分组，并要求发布时原子接受整个 Change Set。若暂不实现 Change Set，则必须先发布 Material，再逐条提交 Relation，不能出现 Relation 指向尚未发布 Material 的状态。

### 15.3 Source 暂存

上传或抓取的原文在审核前进入暂存 Source 区域，不参与正式索引。接受创建 Proposal 后转为正式 Source；拒绝后保留为可清理的未引用暂存数据。

Source 暂存不等于正式 Persona 变化。

## 16. 确定性校验

### 16.1 Material 校验

- Schema 和 entity type 正确；
- ID 使用 `mat_` 前缀；
- title 非空；
- material type 合法；
- user relationships 合法且无冲突；
- knowledge level 合法；
- preference level 合法；
- preference reason 结构合法；
- Tag 和 Evidence 引用存在；
- active Material 的 Source 存在且 Hash 正确；
- DOI、arXiv ID、ISBN 等唯一标识无冲突；
- revision 和时间单调递增。

### 16.2 Relation 校验

- source 必须是 Material；
- target 必须是 Knowledge Node；
- relation type 必须为 `covers`；
- knowledge role 合法；
- salience 合法；
- statement 非空且不能只重复节点标题；
- source 和 target 不能相同；
- active 唯一键不能重复；
- Evidence 引用存在；
- archived Material 不能创建新的 active Relation。

### 16.3 Source 校验

- Manifest Schema 正确；
- Source ID 与目录名一致；
- canonical file 存在；
- files 中的路径均存在；
- 文件 Hash 与实际内容一致；
- content hash 可确定性重建；
- 外部标识符格式正确；
- 原始文件角色存在且唯一或有明确主文件。

## 17. 人类友好投影

除 Web UI 外，构建流程生成可审阅 Markdown：

```text
generated/human/materials.md
generated/human/materials/mat_....md
```

### 17.1 Material 总表

按以下顺序组织：

1. 我的文章；
2. 非常喜欢；
3. 喜欢；
4. 一般；
5. 不喜欢；
6. 未标注。

每项显示标题、作者、年份、理解程度、核心主题和核心方法。

### 17.2 单项 Material 投影

单项投影按 UI 详情顺序生成：

- 基本信息；
- 我的阅读情况；
- 我的评价；
- 知识联系；
- 个人笔记；
- Source 和 Evidence；
- revision 信息。

投影不得复制完整原文，只提供 Source 路径和必要的短 Evidence 片段。

## 18. v2 直接替换约定

本项目不保留 Material v1、Relation v1 或 Source Manifest v1 的兼容层，也不提供运行时迁移器。

- 正式 Material 只接受 `ai-persona.material/v2`；
- 正式 Relation 只接受 `ai-persona.relation/v2`；
- 正式 Source Manifest 只接受 `ai-persona.source-manifest/v2`；
- v1 Schema 文件从项目中删除；
- 当前 Demo 数据一次性改写为 v2，不保留双写、fallback 或版本分支逻辑；
- 以后如导入外部旧数据，应在进入正式存储前离线转换为 v2，而不扩展正式读取器的兼容范围。

## 19. 实施顺序

### 阶段一：Schema 与一次性替换

1. 新增 Material v2 模型；
2. 新增 Source Manifest v2；
3. 扩展 Relation v2；
4. 删除 v1 Schema 和兼容路径，将 Demo 数据直接改写为 v2。

### 阶段二：只读 UI

1. Material 列表；
2. 筛选和领域推导；
3. Material 详情；
4. 知识联系分组；
5. 原文和 Source 阅读；
6. 人类 Markdown 投影。

### 阶段三：新增 Material

1. 上传文件；
2. 粘贴原文；
3. 链接导入；
4. Source 暂存；
5. 去重；
6. 分步表单；
7. 创建 Proposal 和审核。

### 阶段四：修改和归档

1. 编辑 Material；
2. 更新 Source；
3. 归档和恢复；
4. Material revision 和审计历史。

### 阶段五：知识关系维护

1. 新增 Relation；
2. 编辑 Knowledge Role、Salience 和 Statement；
3. 选择 Evidence；
4. 移除 Relation；
5. Material 和 Knowledge 页面双向展示；
6. 可选关系图。

## 20. 验收标准

Material v0.3 完成时应满足：

1. active Material 均关联有效的不可变 Source；
2. 原文、提取文本和个人笔记具有清晰边界；
3. Material 文件不依赖目录层级表达领域；
4. 用户可以区分阅读状态、理解程度和喜欢程度；
5. 用户可以记录喜欢或不喜欢的具体原因；
6. 用户可以通过文件、粘贴文本或链接创建 Material；
7. 导入过程可以发现确定性重复和相似候选；
8. 用户可以编辑和归档 Material；
9. Material–Knowledge Relation 独立保存；
10. 每条 active Material–Knowledge Relation 包含 Role、Salience 和 Statement；
11. UI 可以按角色分组显示知识联系；
12. UI 可以通过知识图推导领域，不重复保存祖先关系；
13. 用户可以新增、编辑和移除知识关系；
14. AI 建议关系不会混入正式关系；
15. Source 更新不会覆盖历史原文和 Evidence；
16. 归档 Material 会原子归档其 active 知识关系；
17. 所有正式变化均经过 Proposal 和人工接受；
18. 接受后增加对象 revision 和 Persona revision；
19. 构建结果确定、可重复；
20. 自动化测试覆盖新增、修改、归档、去重、Source 和 Relation 约束。

## 21. 后续议题

以下内容在 Material v0.3 完成后另行设计：

- Agent 查询接口；
- arXiv 每日候选池和运行数据；
- Material 检索权重和向量索引；
- 自动论文相关性比较；
- Material–Material Relation；
- 引用图；
- 自动生成研究方向；
- 待读列表；
- PDF 标注同步；
- 大文件存储、Git LFS 或对象存储；
- 多设备 Source 同步策略。
