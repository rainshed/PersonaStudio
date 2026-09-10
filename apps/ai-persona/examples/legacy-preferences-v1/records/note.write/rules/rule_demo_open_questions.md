---
schema: ai-persona.preference-rule/v1
id: rule_demo_open_questions
entity_type: preference_rule
pack_id: pref_demo_note_write
strength: preferred
when: 当前主题仍有未解决问题或参数选择时
instruction: 在结尾记录尚未解决的问题和下一步可验证的方向。
avoid: 把不确定问题改写成已经确定的结论。
rationale: Note 既要保存已经理解的内容，也要保存下一步思考入口。
evidence_refs:
  - ev_demo_note
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# 保留开放问题
