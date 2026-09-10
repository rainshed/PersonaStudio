---
schema: ai-persona.preference-context/v1
id: pctx_demo_note
entity_type: preference_context
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
key: research.note
name: 学术 note
description: 为用户撰写或实质性修改科研主题的 Markdown note，包含概念解释、方法推导或结果分析。
activation:
  intents:
  - 写一份从能带知识引入 Berry 曲率的 note
  - 把这次 Wannier 能带插值检查整理成学术笔记
  artifact_types:
  - markdown
  excludes:
  - 只翻译一个术语
  - 撰写面向完全不同读者的宣传文案
---
