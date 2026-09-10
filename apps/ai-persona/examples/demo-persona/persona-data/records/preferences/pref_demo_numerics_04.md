---
schema: ai-persona.preference/v1
id: pref_demo_numerics_04
entity_type: preference
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
scope: contexts
context_refs:
- pctx_demo_numerics
behavior: required
instruction: Save the Julia version, Project.toml, Manifest.toml, random seeds, parameter
  files, and code version so results can be reproduced.
condition: Running and saving numerical experiments.
rationale: A fictional Demo user preference.
---
