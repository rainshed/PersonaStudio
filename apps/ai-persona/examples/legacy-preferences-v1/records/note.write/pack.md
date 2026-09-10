---
schema: ai-persona.preference-pack/v1
id: pref_demo_note_write
entity_type: preference_pack
task_type: note.write
name: 研究 Note 写作偏好
description: 创建以后可以独立重新阅读并恢复推理过程的研究笔记。
activation:
  intents:
    - write_note
    - rewrite_note
    - summarize_as_note
  artifact_types:
    - research_note
    - learning_note
  excludes:
    - email
    - academic_paper
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# 研究 Note 写作偏好

Note 应该保留问题、方法、关键公式的意义以及尚未解决的问题，而不是只保存结论。
