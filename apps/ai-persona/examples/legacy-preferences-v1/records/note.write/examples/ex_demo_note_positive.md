---
schema: ai-persona.preference-example/v1
id: ex_demo_note_positive
entity_type: preference_example
pack_id: pref_demo_note_write
example_type: positive
source_ref: src_demo_note
content_hash: sha256:aead652fe04a2fe64050ddb8dd3fb9034322b232756eb9fa39fac0e6ff741244
title: 用 TEBD 理解一维量子系统的实时演化
applicable_when:
  artifact_type: research_note
  content_features:
    - contains_equations
    - explains_physical_mechanism
why_good:
  - 结构从问题自然过渡到方法和物理图像。
  - 公式部分说明了 Trotter 误差和截断误差的意义。
  - 结尾明确记录了尚未解决的问题。
why_avoid: []
demonstrates_rules:
  - rule_demo_explain_formulas
  - rule_demo_open_questions
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# 优秀研究 Note 样本

原始样本保存在 `src_demo_note`。运行时优先读取样本说明，只有在任务相关且上下文预算允许时才读取原文。
