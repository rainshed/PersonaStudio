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
instruction: When no output format is specified, prefer PNG for research figures suited
  to raster output; provide PDF/SVG for publication layouts or explicit vector requests.
condition: The user has not explicitly specified a format.
rationale: A fictional Demo user preference.
---
