---
schema: ai-persona.preference/v1
id: pref_demo_figure_01
entity_type: preference
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
scope: contexts
context_refs:
- pctx_demo_figure
behavior: preferred
instruction: 未指定输出格式时，适合栅格呈现的科研图优先输出 PNG；论文排版或明确要求矢量时提供 PDF/SVG。
condition: 用户没有明确指定格式。
rationale: 虚构的 Demo 用户偏好。
---
