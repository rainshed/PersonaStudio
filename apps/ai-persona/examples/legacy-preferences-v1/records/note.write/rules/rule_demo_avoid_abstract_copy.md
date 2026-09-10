---
schema: ai-persona.preference-rule/v1
id: rule_demo_avoid_abstract_copy
entity_type: preference_rule
pack_id: pref_demo_note_write
strength: avoid
when: 根据论文或文章整理 Note 时
instruction: 不要只复制或改写原文摘要，应重建问题、方法和个人理解之间的联系。
avoid: 按原文顺序机械摘抄。
rationale: Note 的目的不是保存第二份摘要，而是保存可复用的理解结构。
evidence_refs:
  - ev_demo_note
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# 避免复制摘要
