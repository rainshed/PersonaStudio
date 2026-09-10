# Personal Preferences: 学术 note

- Context key: `research.note`
- Content hash: `sha256:60632e72d7984d749178737cece017b619ab13bac8d0ffb63094c82f269374cf`


## Required

- `pref_demo_note_01` — 先查询与主题相关的 Persona 知识背景；对未记录或仅为 aware 的概念补充清楚的解释，并连接已有知识。
  - When: 为本 Demo 用户撰写专业 note。
  - Why: 虚构的 Demo 用户偏好。
- `pref_demo_note_02` — 新符号首次出现时给出定义，公式前后说明物理意义、假设和适用范围。
  - When: 出现公式、缩写或新记号。
  - Why: 虚构的 Demo 用户偏好。
- `pref_demo_note_04` — 分别说明来源中的结论、自己的推导和待验证的问题；引用材料时保留可定位的来源。
  - When: 汇总论文结论、数值结果或推测。
  - Why: 虚构的 Demo 用户偏好。

## Preferred

- `pref_demo_note_03` — 用连贯段落展开论证，只在逻辑分组时使用列表，避免一句一行和不必要的换行。
  - When: 组织 note 正文。
  - Why: 虚构的 Demo 用户偏好。

## Avoid

No active preferences.

## Reference Examples

- `pex_demo_note_negative` — 学术 note · 反例 (negative)
  - File: `sources/src_demo_sample_note_negative/original.md`
  - Original filename: `src_demo_sample_note_negative`
  - Content hash: `sha256:67af534b8f1e3fefd88216ff7de3c2954fc69d241b5c5433cf436e1969e8c577`
  - When: 为用户撰写或实质性修改科研主题的 Markdown note，包含概念解释、方法推导或结果分析。
  - 对照本场景的规则检查信息、步骤与记录是否完整。
- `pex_demo_note_positive` — 学术 note · 正例 (positive)
  - File: `sources/src_demo_sample_note_positive/original.md`
  - Original filename: `src_demo_sample_note_positive`
  - Content hash: `sha256:d5775ac70e187848826439cb076d08685df88fb8506d12dbd2993e57e1154c5c`
  - When: 为用户撰写或实质性修改科研主题的 Markdown note，包含概念解释、方法推导或结果分析。
  - 对照本场景的规则检查信息、步骤与记录是否完整。

## Final Check

- [ ] 先查询与主题相关的 Persona 知识背景；对未记录或仅为 aware 的概念补充清楚的解释，并连接已有知识。
- [ ] 新符号首次出现时给出定义，公式前后说明物理意义、假设和适用范围。
- [ ] 分别说明来源中的结论、自己的推导和待验证的问题；引用材料时保留可定位的来源。
