# Personal Task Preferences: 研究 Note 写作偏好

- Pack ID: `pref_demo_note_write`
- Task type: `note.write`
- Content hash: `sha256:221274608b626a105fae12fa986cfeb42d8897cfe0d43c3d78fd8c2b9e2342e5`
- Pack revision: `1`

## Goal

创建以后可以独立重新阅读并恢复推理过程的研究笔记。

## Required

- `rule_demo_explain_formulas` — 解释重要符号的物理意义，并说明公式在当前论证中的作用。
  - When: Note 中出现重要公式时
  - Avoid: 只给出公式而不解释其用途。

## Preferred

- `rule_demo_open_questions` — 在结尾记录尚未解决的问题和下一步可验证的方向。
  - When: 当前主题仍有未解决问题或参数选择时
  - Avoid: 把不确定问题改写成已经确定的结论。

## Avoid

- `rule_93f9f41d8d644f92afdf74a42156a2ae` — 生成的md格式note不要有不必要的换行
- `rule_demo_avoid_abstract_copy` — 不要只复制或改写原文摘要，应重建问题、方法和个人理解之间的联系。
  - When: 根据论文或文章整理 Note 时
  - Avoid: 按原文顺序机械摘抄。

## Reference Examples

- `ex_demo_note_positive` — 用 TEBD 理解一维量子系统的实时演化 (positive, source `src_demo_note`)
  - 结构从问题自然过渡到方法和物理图像。
  - 公式部分说明了 Trotter 误差和截断误差的意义。
  - 结尾明确记录了尚未解决的问题。

## Final Check

- [ ] 解释重要符号的物理意义，并说明公式在当前论证中的作用。
- [ ] 生成的md格式note不要有不必要的换行
- [ ] 不要只复制或改写原文摘要，应重建问题、方法和个人理解之间的联系。
