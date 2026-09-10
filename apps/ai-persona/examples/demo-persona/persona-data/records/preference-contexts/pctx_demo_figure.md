---
schema: ai-persona.preference-context/v1
id: pctx_demo_figure
entity_type: preference_context
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
key: research.figure
name: Research Figures
description: Create or substantially revise plots of research data, including curve
  comparisons, scaling analyses, and publication figures. Does not apply when only
  discussing the physics in an existing figure.
activation:
  intents:
  - Plot the bands with and without spin-orbit coupling in the same figure
  - Adjust the axes and legend of this error-bar plot
  artifact_types:
  - png
  - pdf
  - svg
  excludes:
  - Explain an existing image without modifying it
  - Create promotional illustrations unrelated to research data
---
