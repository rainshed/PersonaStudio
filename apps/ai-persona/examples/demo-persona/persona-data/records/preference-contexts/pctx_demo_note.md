---
schema: ai-persona.preference-context/v1
id: pctx_demo_note
entity_type: preference_context
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
key: research.note
name: Academic Notes
description: Write or substantially revise a Markdown note on a research topic, including
  conceptual explanations, method derivations, or analysis of results.
activation:
  intents:
  - Write a note introducing Berry curvature from band-structure concepts
  - Turn this Wannier band-interpolation check into an academic note
  artifact_types:
  - markdown
  excludes:
  - Translate a single term
  - Write promotional copy for an entirely different audience
---
