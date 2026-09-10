# AI Persona：材料智能导入需求文档（arXiv 与 Markdown）

> 设计与历史参考：本文可能包含早期阶段或规划，不是本次发行的验收报告。当前入口与能力以[使用指南](../../../docs/GETTING_STARTED.zh-CN.md)和[兼容矩阵](../../../docs/FEATURE_PARITY.md)为准。

| 字段 | 内容 |
|---|---|
| 文档状态 | 需求讨论稿 |
| 版本 | 0.1 |
| 日期 | 2026-09-04 |
| 适用项目 | AI Persona |
| 关联设计 | [AI_PERSONA_MATERIAL_DESIGN.zh-CN.md](./AI_PERSONA_MATERIAL_DESIGN.zh-CN.md) |
| 关联存储设计 | [AI_PERSONA_STORAGE_DESIGN.zh-CN.md](./AI_PERSONA_STORAGE_DESIGN.zh-CN.md) |

## 1. 文档目的

本文档定义 AI Persona 中“添加材料”的智能导入需求。

本期只支持两类输入：

1. arXiv 链接或 arXiv ID；
2. 本地 Markdown 文件。

本期重点解决用户导入材料时需要重复手工填写标题、作者、摘要、发表时间、外部标识符和规范链接的问题。系统应尽可能从可靠来源自动提取这些信息，并让用户只处理缺失、冲突或属于个人判断的字段。

本文档描述产品行为、数据边界、异常处理和验收标准，不要求改变 AI Persona 已有的 Source 不可变、Proposal 审核和正式发布原则。

## 2. 背景与问题

当前添加材料页面同时展示原文输入、书目信息、阅读状态、偏好、摘要、个人笔记和标签。即使原文中已经包含标题、作者和摘要，用户仍需要手工复制到表单。

当前流程存在以下问题：

1. 系统在最终提交阶段才读取原文，无法在用户填写表单前自动回填；
2. arXiv 链接被当作普通 URL 处理，没有利用 arXiv 的结构化元数据；
3. Markdown 原文虽然可读，但其中的 frontmatter、一级标题、作者区域和 Abstract 小节没有用于填写 Material；
4. PDF 原文、来源事实和用户个人判断显示在同一长表单中，用户难以区分哪些必须填写；
5. 重复检查发生得较晚，用户可能填完表单后才发现材料已经存在；
6. 表单默认值可能让系统在未得到用户确认时记录“读过”或“喜欢”。

## 3. 产品目标

### 3.1 核心目标

1. 用户只需提供 arXiv 链接、arXiv ID 或 Markdown 文件即可开始导入；
2. 系统在展示完整材料表单前完成来源识别和元数据提取；
3. 标题、作者、原文摘要、发表时间、DOI、arXiv ID、材料类型和规范链接应尽可能自动填写；
4. 自动填写的字段必须可编辑，并说明信息来源；
5. 低置信度、冲突或无法识别的字段必须明确提示用户确认；
6. 阅读状态、理解程度、偏好和个人笔记不得根据原文自动认定；
7. 重复材料和 arXiv 新版本应在生成 Proposal 前被识别；
8. 用户确认后仍生成待审核 Proposal，不直接修改有效 Persona；
9. 原文和用于提取的元数据应具有可追溯性。

### 3.2 用户体验目标

对于正常的 arXiv 导入，用户应只需要：

1. 粘贴链接或 ID；
2. 检查自动识别结果；
3. 选择自己与材料的关系；
4. 生成待审核 Proposal。

对于结构清晰的 Markdown，用户应只需要上传文件并处理系统标记为“需要确认”的少数字段。

### 3.3 成功标准

- 有效 arXiv 输入能够自动填充标题、作者、摘要、日期、arXiv ID 和规范链接；
- 包含规范 frontmatter 的 Markdown 能够确定性填充所有已声明字段；
- 项目现有 Mathpix 风格论文 Markdown 能够识别 H1 标题和 Abstract 小节；
- 系统不会因为导入行为自动记录用户“读过”“参与撰写”或“喜欢”；
- 已存在材料能够在用户填写个人信息之前被发现；
- 自动提取失败不会导致原文丢失或产生半完成的正式记录。

## 4. 范围

### 4.1 本期包含

| 能力 | 本期要求 |
|---|---|
| arXiv ID 识别 | 支持新版、旧版和可选版本号 |
| arXiv URL 识别 | 支持 abstract 与 PDF 链接 |
| arXiv 元数据获取 | 标题、作者、摘要、日期、DOI、期刊信息、分类和版本 |
| arXiv 原文保存 | 下载并保存指定版本 PDF；有 HTML 时一并保存 |
| arXiv AI 可读文本 | 优先由官方 HTML 生成保留标题层级的提取文本 |
| Markdown 上传 | 支持本地 `.md` 文件 |
| Markdown frontmatter | 解析常见字段及字段别名 |
| Markdown 结构提取 | H1、作者候选、Abstract/摘要、日期、arXiv、DOI 和语言 |
| 元数据预览 | 提交 Proposal 前展示并允许编辑 |
| 字段来源 | 展示自动填写字段的来源与确认状态 |
| 重复检测 | arXiv ID、DOI、文件 Hash、标题与作者候选 |
| arXiv 版本处理 | 已存在时提供更新原文版本的路径 |
| Proposal 边界 | 用户确认后才创建 Material Proposal |

### 4.2 本期不包含

- 任意网页 URL 导入；
- DOI 作为独立输入入口；
- 用户直接上传 PDF；
- 用户直接上传 HTML、TXT、Word、LaTeX 或 EPUB；
- OCR；
- LLM 元数据提取；
- 自动生成知识节点或 Material–Knowledge Relation；
- 自动选择正式 Tag；
- 自动生成用户偏好、理解程度或阅读范围；
- 批量导入；
- arXiv 定时同步或新版本后台监控；
- 论文推荐、排序或待阅读队列。

arXiv 导入过程中由系统下载 PDF 和可用 HTML，不等于支持用户直接上传任意 PDF 或 HTML。

## 5. 核心原则

### 5.1 先识别，后填写

添加材料必须拆成两个用户可感知的阶段：

```text
提供来源 → 识别与查重 → 确认材料信息和个人状态 → Proposal 审核
```

系统不得要求用户先填写可从来源中提取的字段，再开始读取来源。

### 5.2 来源事实与用户事实分离

来源事实可以自动填写：

- 材料类型；
- 标题；
- 作者；
- 原文摘要；
- 发表时间；
- 期刊或来源；
- 语言；
- arXiv ID；
- DOI；
- 规范链接。

用户事实必须由用户确认：

- 是否参与撰写；
- 研究过、读过或浏览过；
- 理解程度；
- 喜欢程度；
- 喜欢或不喜欢的原因；
- 阅读范围；
- 个人笔记。

即使 arXiv 作者列表中出现与用户相同的姓名，系统也只能提示“可能是你的论文”，不得自动选中 `authored`。

### 5.3 确定性来源优先

字段取值优先级如下：

1. 用户在识别结果页上的明确编辑；
2. arXiv API 或 Markdown frontmatter；
3. Markdown 明确结构；
4. 保守的文本模式识别；
5. 文件名兜底。

本期不使用 LLM。无法可靠识别时应留空或要求确认，不应生成看似完整但无法解释的结果。

### 5.4 自动填写不等于自动发布

自动提取结果只是 Import Draft。只有用户确认后才能创建 Source 暂存和 Material Proposal；只有 Proposal 被接受后才能进入有效 Persona。

## 6. 目标用户流程

### 6.1 第一步：提供来源

添加材料首页只展示两个入口：

1. “arXiv”：粘贴 arXiv 链接或 ID；
2. “Markdown”：选择或拖入 `.md` 文件。

页面主操作为“识别材料”。完整 Material 表单在识别前不展示。

### 6.2 第二步：识别与查重

系统完成以下操作：

1. 判断输入是否合法；
2. 获取或读取原文；
3. 提取元数据；
4. 规范化字段；
5. 搜索完全重复和可能重复的 Material；
6. 生成临时 Import Draft；
7. 返回识别摘要、警告和下一步操作。

识别过程中页面应显示明确状态，例如：

- 正在读取 arXiv 元数据；
- 正在下载论文原文；
- 正在解析 Markdown；
- 正在检查重复材料。

### 6.3 第三步：确认信息

识别结果页分为三组：

1. “已识别”：高置信度且无冲突的来源事实；
2. “需要确认”：低置信度、来源冲突或使用兜底值的字段；
3. “我的状态”：必须由用户确认的阅读关系和可选个人信息。

页面顶部显示摘要，例如：

> 已自动填写 7 项，2 项需要确认。

所有自动填写字段必须可编辑。用户编辑后，该字段状态变为“用户已确认”，后续重新渲染不得覆盖用户值。

### 6.4 第四步：生成 Proposal

用户完成所有必填确认后选择“生成待审核提案”。系统随后：

1. 固化待发布 Source Bundle；
2. 使用用户确认后的字段创建 Material Proposal；
3. 跳转到现有审核页；
4. 不直接发布 Material。

## 7. arXiv 输入需求

### 7.1 支持的输入形式

系统必须识别以下形式：

```text
1706.03762
1706.03762v7
arXiv:1706.03762
arXiv:1706.03762v7
https://arxiv.org/abs/1706.03762
https://arxiv.org/abs/1706.03762v7
https://arxiv.org/pdf/1706.03762
https://arxiv.org/pdf/1706.03762v7
https://arxiv.org/pdf/1706.03762v7.pdf
hep-th/9901001
hep-th/9901001v2
```

允许 URL 包含查询参数或片段，但它们不得影响 ID 解析。

不属于 `arxiv.org` 的任意 URL 在本期必须被拒绝，并提示当前仅支持 arXiv。

### 7.2 ID 与版本规范化

系统必须把输入拆分为：

- `base_id`：不带版本号的稳定 arXiv ID；
- `version`：可选的 `vN`；
- `requested_url`：用户提供的原始输入或 URL；
- `canonical_url`：不带版本号的 `https://arxiv.org/abs/{base_id}`；
- `source_url`：实际保存版本对应的 arXiv abstract URL；PDF 和 HTML 获取地址记录在导入元数据附件中。

Material 的 `bibliography.identifiers.arxiv` 保存 `base_id`。Source Origin 单独保存版本号。重复检查必须使用 `base_id`，不能把同一论文的不同版本当作不同 Material。

### 7.3 元数据获取

系统使用 arXiv 的结构化元数据接口按 ID 查询。至少读取：

| arXiv 数据 | Material 或 Source 字段 | 要求 |
|---|---|---|
| entry title | `title` | 合并多余空白，保留字符内容 |
| author name | `bibliography.authors` | 保持 arXiv 返回顺序 |
| summary | `abstract` | 合并换行，不改写语义 |
| published | `bibliography.published_at` | 转为 `YYYY-MM-DD` |
| arxiv:doi | `bibliography.identifiers.doi` | 使用现有 DOI 规范化规则 |
| arxiv:journal_ref | `bibliography.venue` | 有值时填写 |
| entry id | Source Origin | 解析实际版本 |
| primary category/categories | Source 元数据附件 | 本期不自动创建 Tag |
| alternate link | `bibliography.canonical_url` | 最终规范化为 abstract URL |

`material_type` 固定建议为 `paper`。`language` 根据标题和摘要进行本地语言识别；结果可自动填写，但必须允许修改。

### 7.4 版本选择

- 输入包含版本号时，下载指定版本；
- 输入不包含版本号时，下载 arXiv 返回的最新版本；
- Source Origin 必须记录最终下载的版本；
- 界面必须显示最终版本，例如“将保存 arXiv v7”；
- 如果指定版本不存在，提示用户修改输入，不得静默下载其他版本。

### 7.5 原文与元数据保存

arXiv Import Draft 至少暂存：

- 下载的 PDF；
- 若 arXiv 存在该版本的 HTML，保存 HTML 及由其生成的结构化提取文本；
- arXiv 原始元数据响应；
- 规范化后的元数据；
- 请求 ID、最终版本和获取时间；
- 各文件 Hash。

Proposal 被接受后，正式 Source Bundle 至少包含：

```text
manifest.yaml
original.pdf
attachments/arxiv-metadata.xml
attachments/metadata.json
# 仅在 arXiv 提供 HTML 时
attachments/arxiv.html
attachments/extracted.md
```

元数据附件作为导入事实的追溯依据，不作为第二份 Material 正文。PDF 是用于版式校验和长期归档的 canonical original；`extracted.md` 是 AI 和行级 Evidence 的优先文本。HTML 属于 arXiv 由 LaTeX 转换的派生表示，不得取代 PDF 作为唯一归档文件。

HTML 获取与转换必须是 best effort：不存在、超时或转换失败时，自动降级为 Atom 元数据 + PDF，不得阻止导入。

## 8. Markdown 输入需求

### 8.1 文件要求

- 文件扩展名必须为 `.md`；
- 默认按 UTF-8 读取，允许 UTF-8 BOM；
- 换行统一为 `\n`，但正式 Source 保存用户上传的原始字节；
- 沿用项目 Source 大小上限，最大 50 MB；
- 空文件必须拒绝；
- 二进制或无法合理解码的文件必须提示格式错误；
- Markdown 内容始终作为不可信来源数据处理。

### 8.2 frontmatter 解析

如果文件以 YAML frontmatter 开始，系统应使用安全、受限的 YAML 解析器读取。禁止执行自定义标签或构造任意对象。

支持以下规范字段和别名：

| 目标字段 | 接受的 frontmatter 字段 | 转换规则 |
|---|---|---|
| 标题 | `title`、`name` | 字符串 |
| 作者 | `authors`、`author` | 列表优先；标量作为待确认候选 |
| 原文摘要 | `abstract`、`description` | 字符串 |
| 发表时间 | `published_at`、`published`、`date` | 规范化为年、年月或日期 |
| 来源 | `venue`、`journal` | 字符串 |
| 语言 | `language`、`lang` | 规范化语言代码 |
| arXiv ID | `arxiv`、`arxiv_id` | 去除前缀并规范化 |
| DOI | `doi` | 去除 DOI URL 或前缀并规范化 |
| 规范链接 | `canonical_url`、`url` | 只接受 HTTP/HTTPS |
| 材料类型 | `material_type`、`type` | 映射到现有 Material 类型 |
| 别名 | `aliases` | 字符串列表 |

frontmatter 中存在但本期不支持的字段不得导致导入失败，也不得直接写入 Material。系统可以在识别结果中显示“已忽略 N 个字段”。

frontmatter 格式错误时：

1. 不创建正式数据；
2. 保留文件用于当前 Import Draft；
3. 显示解析警告；
4. 继续尝试 Markdown 结构提取；
5. 要求用户确认可能受到影响的字段。

### 8.3 无 frontmatter 或字段缺失时的结构提取

字段提取优先级如下：

| 字段 | 第一来源 | 第二来源 | 最终兜底 |
|---|---|---|---|
| `title` | frontmatter `title` | 第一个 H1 | 文件名去扩展名 |
| `authors` | frontmatter 作者列表 | H1 与 Abstract 之间的作者候选区 | 留空 |
| `abstract` | frontmatter abstract | Abstract/摘要小节 | 留空 |
| `published_at` | frontmatter 日期 | `(Dated: ...)` 等明确日期 | 留空 |
| `arxiv` | frontmatter | 全文中的明确 arXiv 模式 | 留空 |
| `doi` | frontmatter | 全文中的明确 DOI 模式 | 留空 |
| `language` | frontmatter | 标题与摘要语言识别 | 留空 |
| `material_type` | frontmatter | 论文结构判断 | `note` |

#### 标题

- 使用第一个一级标题 `# Title`；
- 去除首尾空白，不改变标题中的数学符号和 Unicode；
- 如果使用文件名兜底，字段必须标记为“需要确认”。

#### 作者候选区

当文件满足以下条件时，可以尝试识别作者：

1. 已识别 H1 标题；
2. 后续存在 Abstract/摘要标题；
3. 标题和 Abstract 之间存在非空文本。

解析器应识别人名候选并尽量排除：

- 单位和地址；
- 电子邮件；
- ORCID URL；
- `${}^{1,2}` 等上下标单位标记；
- `<br>` 分隔后的 affiliation；
- `*`、`†` 等通讯作者符号；
- `(Dated: ...)` 日期行。

通过启发式得到的作者列表默认标记为“需要确认”。解析器不得为了填满字段而把整个单位段落保存为作者姓名。

#### Abstract/摘要

- 标题匹配不区分大小写；
- 支持任意 Markdown 标题层级；
- 英文匹配 `Abstract`，中文匹配 `摘要`；
- 内容从该标题下一行开始，到下一个同级或更高层级标题为止；
- 保留段落和行内公式，去除首尾空行；
- 不把 Abstract 文本复制进个人笔记或 Persona `summary`。

#### 日期

除 frontmatter 外，本期至少支持：

```text
(Dated: July 18, 2025)
(Dated: 2025-07-18)
Published: 2025-07-18
```

无法无歧义解析的日期应留空。

#### 材料类型

- frontmatter 提供合法类型时使用该类型；
- 同时存在标题、作者候选和 Abstract 时，建议为 `paper`；
- 其他 Markdown 默认建议为 `note`；
- 结构推断得到的类型必须允许用户一键修改。

### 8.4 Markdown Source 保存

Markdown 原始文件本身就是可读文本。正式 Source Bundle 至少包含：

```text
manifest.yaml
original.md
attachments/metadata.json
```

`metadata.json` 保存规范化提取结果、字段来源、解析器版本和警告。系统不得用规范化后的文本覆盖 `original.md`。

## 9. 字段状态与来源展示

每个自动识别字段在 Import Draft 中必须包含：

```json
{
  "field": "title",
  "value": "Attention Is All You Need",
  "source": "arxiv_api",
  "source_locator": "entry.title",
  "status": "autofilled",
  "warnings": []
}
```

`status` 至少支持：

- `autofilled`：可靠来源给出且无冲突；
- `review_required`：启发式、兜底或存在冲突；
- `missing`：没有候选值；
- `user_confirmed`：用户已查看并确认或修改。

UI 使用人类可读的来源标签：

- 来自 arXiv；
- 来自 Markdown frontmatter；
- 来自第一个 H1；
- 来自 Abstract 小节；
- 根据正文结构识别；
- 根据文件名填写。

用户无需看到内部数值置信度。系统可以内部记录置信度，但界面应以“已识别”“需要确认”“缺失”表达。

## 10. Abstract 与 Summary 的数据边界

Material 必须新增独立的 `abstract` 字段：

| 字段 | 含义 | 来源 |
|---|---|---|
| `abstract` | 原作者或原文提供的摘要 | arXiv、frontmatter 或 Abstract 小节 |
| `summary` | 用户或后续 AI 对材料及其个人相关性的概括 | 用户输入或独立审核后的建议 |

自动导入不得用 `abstract` 覆盖 `summary`，也不得把 `summary` 伪装成原文摘要。

由于现有 Material 使用严格 Schema，实施时必须同步更新：

- Pydantic Material 模型；
- Material JSON Schema；
- Markdown 存储与加载；
- Proposal 可编辑字段；
- Material 详情页与审核页；
- 生成投影和索引；
- 旧 Material 迁移或兼容读取策略。

建议将新正式记录版本升级为 `ai-persona.material/v3`，旧 v2 记录在迁移时补充空 `abstract`。

## 11. 用户个人字段要求

### 11.1 阅读关系

系统不得默认选中 `authored`、`studied`、`read` 或 `skimmed`。用户必须明确选择符合现有 Material 约束的关系后才能继续。

### 11.2 理解程度

默认值为 `unspecified`。导入器不得根据论文难度、篇幅、用户是否是作者或文件内容推断理解程度。

### 11.3 喜欢程度

默认值为 `unspecified`，不得默认 `liked`。偏好原因默认为空。

### 11.4 可选字段

以下字段默认折叠，不阻塞导入：

- 阅读范围；
- 偏好原因；
- Persona `summary`；
- 个人 Markdown 笔记；
- Tag。

## 12. 重复检测与 arXiv 版本处理

### 12.1 检测时机

重复检测必须在识别结果页展示之前完成，而不是等用户提交完整表单后才报错。

### 12.2 完全重复

以下任一条件成立时视为完全重复：

1. arXiv `base_id` 与现有 active Material 相同；
2. DOI 与现有 active Material 相同；
3. Markdown 原始文件 Hash 与现有 active Material Source 相同。

完全重复时不得默认新建 Material。界面应展示现有材料标题并提供：

- 打开已有材料；
- 若为 arXiv 新版本，进入“更新原文版本”；
- 取消导入。

### 12.3 可能重复

以下情况视为可能重复：

- 规范化标题完全相同；
- 标题高度相似且发表年份相同；
- 标题高度相似且至少一位作者相同。

可能重复不直接阻止操作，但用户必须先查看候选，再明确选择“继续新建”或“使用已有材料”。

### 12.4 arXiv 新版本

当 `base_id` 相同但 Source 版本不同时：

- 不创建第二个 Material；
- 显示已有版本和请求版本；
- 请求版本较新时，提供“更新到 vN”；
- 请求版本相同，提示已经保存；
- 请求版本更旧时，默认不建议回退，但允许用户取消并保留已有版本；
- 更新仍创建新的不可变 Source，并通过 Proposal 修改原 Material 的 `source_ref`。

## 13. Import Draft 与正式数据边界

### 13.1 Import Draft

识别阶段创建临时 Import Draft。建议最少包含：

```text
draft_id
input_kind
original_input
temporary_files
detected_metadata
field_states
warnings
duplicate_matches
created_at
expires_at
```

Import Draft 不是正式 Persona 记录，不进入搜索、索引、MCP 或人类投影。

### 13.2 生命周期

- Draft 在用户开始识别时创建；
- 用户修改识别结果时更新 Draft；
- 生成 Proposal 后 Draft 关闭；
- 用户取消时删除 Draft 和临时文件；
- 异常退出或长期未使用的 Draft 应按 TTL 清理；
- 清理 Draft 不得删除已被 Proposal 引用的暂存 Source。

### 13.3 Proposal 与发布

- 识别完成不创建 Proposal；
- 用户确认后创建 staged Source 和 Material Proposal；
- Proposal 拒绝时清理未发布 Source；
- Proposal 接受时发布 Source 和 Material；
- 已有 Proposal、Hash 校验和不可变 Source 规则继续生效。

## 14. 页面需求

### 14.1 来源输入页

页面必须包含：

- arXiv 输入框；
- Markdown 文件选择或拖放区；
- 当前支持范围说明；
- “识别材料”主按钮；
- 文件大小和格式提示。

同一次识别只能选择一种输入。两种输入同时存在时要求用户保留其中一种。

### 14.2 识别结果页

页面必须包含：

- 原文类型和文件/链接摘要；
- 自动填写字段数；
- 需要确认字段数；
- 重复或版本提示；
- 可编辑的材料信息；
- 每个自动字段的来源标签；
- 用户阅读关系；
- 默认折叠的可选个人字段；
- “返回重新选择来源”；
- “生成待审核提案”。

### 14.3 字段排序

“需要确认”的字段排在“已识别”的字段之前。高置信度书目信息允许折叠，避免用户重新阅读一整张长表单。

### 14.4 错误保留

用户提交时若某字段校验失败：

- 返回识别结果页；
- 保留用户已编辑内容；
- 定位并解释具体字段；
- 不要求用户重新上传 Markdown 或重新查询 arXiv。

## 15. 异常与降级行为

### 15.1 arXiv

| 异常 | 系统行为 |
|---|---|
| ID 格式无效 | 在输入框下说明支持格式 |
| arXiv 无此记录 | 提示检查 ID，不创建 Draft 结果 |
| 网络超时 | 保留输入并允许重试 |
| API 成功但 PDF 下载失败 | 显示元数据，但禁止生成 Proposal，并允许重试原文下载 |
| HTML 不存在或转换失败 | 保留 Atom 元数据和 PDF，继续导入 |
| 指定版本不存在 | 明确提示版本不存在，不下载其他版本 |
| DOI 格式异常 | 保留其他字段，将 DOI 标为需要确认或留空 |
| arXiv 元数据缺字段 | 其余字段正常显示，缺失字段留空 |

### 15.2 Markdown

| 异常 | 系统行为 |
|---|---|
| 文件为空 | 拒绝并提示 |
| 文件超过上限 | 拒绝并提示 50 MB 上限 |
| 无法解码 | 拒绝并说明需要 UTF-8 Markdown |
| frontmatter 无效 | 警告并继续结构提取 |
| 没有 H1 | 使用文件名并要求确认标题 |
| 没有 Abstract | `abstract` 留空，不阻止导入 |
| 作者区域含糊 | 显示候选文本并要求确认 |
| 提取到非法 DOI/arXiv | 不写入正式字段，显示警告 |

## 16. 安全与隐私要求

1. 本期服务端只能主动请求 arXiv 官方域名，不提供任意 URL 抓取；
2. arXiv 重定向后的目标仍必须经过域名和协议校验；
3. 禁止访问 loopback、内网地址和本地文件协议；
4. 所有网络请求必须设置连接、读取和总时限；
5. 下载必须流式执行并强制 50 MB 上限；
6. Markdown frontmatter 使用安全解析器，拒绝 YAML 自定义对象；
7. Markdown、arXiv 摘要和 PDF 内容始终作为不可信数据，不得执行其中的指令；
8. 错误信息不得暴露系统内部绝对路径或堆栈；
9. Draft 与临时文件只保存在当前 Persona 的状态空间内；
10. 用户取消或 Draft 过期后，应安全清理未被 Proposal 引用的临时数据。

## 17. 非功能需求

### 17.1 性能

- 典型 Markdown 文件的本地识别目标为 1 秒内完成；
- arXiv 识别应在单次页面操作内完成，并提供进行中状态；
- 网络请求不能无限阻塞页面；
- Hash、解析和查重不得重复读取同一大文件多次。

### 17.2 可测试性

- arXiv API 和 PDF 下载必须可以在测试中替换为固定响应；
- 每个字段解析器应可单独进行单元测试；
- 解析结果必须包含解析器名称和版本；
- `tests_raw` 中的真实论文 Markdown 应作为回归测试 fixture 使用；
- 测试不得依赖实时 arXiv 网络服务。

### 17.3 可维护性

arXiv 和 Markdown 使用独立解析器，但输出统一的 Import Draft 字段模型。UI 和 Proposal 层不得直接解析 Atom XML、Markdown 或正则表达式。

推荐的模块边界：

```text
material_imports/
  models.py
  service.py
  arxiv.py
  markdown.py
  duplicates.py
  repository.py
```

## 18. 验收场景

### AC-01：arXiv abstract 链接

**Given** 用户输入有效的 `https://arxiv.org/abs/{id}`
**When** 用户选择“识别材料”
**Then** 系统自动填写 paper、标题、作者、abstract、日期、基础 arXiv ID 和 canonical URL，并显示将保存的版本。

### AC-02：arXiv PDF 链接与版本

**Given** 用户输入带版本号的 PDF URL
**When** 系统完成识别
**Then** Material arXiv ID 不包含版本号，Source Origin 保存版本号，下载对应版本 PDF。

### AC-03：无版本 arXiv ID

**Given** 用户只输入基础 arXiv ID
**When** arXiv 返回最新版本
**Then** 系统下载最新版本并在确认页明确显示版本。

### AC-04：arXiv 已存在

**Given** 当前 Persona 已存在相同基础 arXiv ID
**When** 用户再次导入
**Then** 系统在显示个人字段前提示已有材料；相同版本不允许重复创建，新版本提供更新入口。

### AC-04A：arXiv 提供 HTML

**Given** arXiv 同时提供指定版本的 PDF 和 HTML
**When** 用户完成导入并接受 Proposal
**Then** Source 以 PDF 为 canonical original，同时保存 HTML，并将保留标题层级的提取文本标记为 AI 优先文本。

### AC-05：完整 Markdown frontmatter

**Given** Markdown frontmatter 包含标题、作者列表、abstract、日期和 DOI
**When** 用户上传文件
**Then** 系统从 frontmatter 自动填写对应字段并标记来源，不要求用户重复输入。

### AC-06：Mathpix 风格论文 Markdown

**Given** Markdown 依次包含 H1、作者与单位文本、`#### Abstract` 和摘要正文
**When** 用户上传文件
**Then** 系统识别 H1 标题和摘要，给出作者候选并要求确认，不把单位地址作为正式作者。

### AC-07：普通研究 Note

**Given** Markdown 只有 H1 和正文，没有作者或 Abstract
**When** 用户上传文件
**Then** 系统建议类型为 note、使用 H1 作为标题，作者和 abstract 留空，并允许继续导入。

### AC-08：标题兜底

**Given** Markdown 没有 frontmatter 标题和 H1
**When** 用户上传文件
**Then** 系统使用文件名作为标题候选并标记“需要确认”。

### AC-09：用户事实不自动填写

**Given** 任意成功识别的 arXiv 或 Markdown
**When** 用户进入确认页
**Then** authored、studied、read、skimmed 均未选中，理解程度和喜欢程度为 unspecified。

### AC-10：用户编辑得到保留

**Given** 用户修改自动识别的标题或作者
**When** 其他字段校验失败并重新显示页面
**Then** 系统保留用户修改值，字段状态为 user_confirmed，不恢复自动提取值。

### AC-11：Markdown Hash 重复

**Given** 上传文件的 Hash 已被 active Material 使用
**When** 系统执行识别
**Then** 系统展示已有 Material，不允许默认创建重复 Material。

### AC-12：Proposal 安全边界

**Given** 用户完成识别和个人状态确认
**When** 用户选择“生成待审核提案”
**Then** 系统只创建 staged Source 和 pending Proposal；在 Proposal 接受前，有效 Persona 不发生变化。

### AC-13：取消与清理

**Given** 用户已完成 arXiv 下载或 Markdown 上传
**When** 用户取消导入或 Draft 过期
**Then** 未被 Proposal 引用的临时文件被清理，正式 Source 和 Material 不发生变化。

## 19. 测试要求

### 19.1 单元测试

- 所有支持的 arXiv ID 和 URL 形式；
- 新旧 arXiv ID 与版本拆分；
- arXiv Atom 字段映射；
- Markdown frontmatter 字段与别名；
- H1 标题提取；
- Abstract/摘要边界；
- Mathpix 作者候选清理；
- 日期、DOI 和 arXiv 正则；
- 字段来源与状态；
- Draft TTL 和清理判断；
- 重复与新版本分类。

### 19.2 集成测试

- 来源输入页到识别结果页；
- 识别结果到 Proposal；
- Proposal 接受、拒绝与 Source 生命周期；
- 重复材料跳转；
- arXiv 新版本更新；
- 校验失败时保留用户输入；
- 中英文 UI 文案；
- 无实时网络的 arXiv 固定响应测试。

### 19.3 回归测试

至少选择以下真实 Markdown 结构作为 fixture：

- 无 frontmatter 的论文；
- Mathpix 导出的作者与单位混排论文；
- 中文标题或摘要；
- 普通个人 Note；
- 含公式、HTML `<br>` 和图片链接的 Markdown；
- 无 H1、无 Abstract 的不完整 Markdown。

## 20. 交付优先级

### P0：可用闭环

1. 两阶段导入流程；
2. Import Draft；
3. arXiv ID/URL 规范化；
4. arXiv 元数据获取和 PDF 保存；
5. Markdown frontmatter、H1 和 Abstract 提取；
6. 独立 `abstract` 字段；
7. 识别结果页与字段来源；
8. 用户关系无默认选中，喜欢程度默认为 unspecified；
9. arXiv ID、DOI 和文件 Hash 提前查重；
10. Proposal 与 Source 生命周期集成。

### P1：质量增强

1. Mathpix 作者候选清理；
2. Markdown 日期与语言识别；
3. 标题、年份和作者模糊重复候选；
4. arXiv 新版本更新入口；
5. Draft TTL 自动清理；
6. 提取元数据附件和解析器版本追溯。

## 21. 完成定义

本需求在满足以下条件后视为完成：

1. P0 功能全部实现；
2. AC-01 至 AC-13 全部通过；
3. arXiv 测试不依赖实时网络；
4. 至少三份项目真实 Mathpix Markdown 通过回归测试；
5. 新旧 Material 数据可以被 Store、Proposal、审核、投影和索引正确处理；
6. 用户导入 arXiv 时无需手工复制标题、作者和摘要；
7. 用户导入结构清晰的 Markdown 时无需手工复制已存在的信息；
8. 系统没有在用户未确认时写入阅读、作者身份、理解或偏好判断；
9. 接受 Proposal 前，有效 Persona 和正式 Source 不发生变化。

## 22. 外部接口参考

- [arXiv API Access](https://info.arxiv.org/help/api/index.html)
- [arXiv API User Manual](https://info.arxiv.org/help/api/user-manual.html)
- [arXiv Identifier Scheme](https://info.arxiv.org/help/arxiv_identifier.html)

实现必须遵守 arXiv 当时有效的 API 使用条款、请求频率和署名要求；外部接口约束发生变化时，应更新实现与本文档。
