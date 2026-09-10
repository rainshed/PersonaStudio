---
schema: ai-persona.preference-rule/v1
id: rule_demo_explain_formulas
entity_type: preference_rule
pack_id: pref_demo_note_write
strength: required
when: Note 中出现重要公式时
instruction: 解释重要符号的物理意义，并说明公式在当前论证中的作用。
avoid: 只给出公式而不解释其用途。
rationale: 以后重新阅读时不应依赖原始论文才能恢复推理。
evidence_refs:
  - ev_demo_note
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# 解释重要公式
