---
schema: ai-persona.preference/v1
id: pref_demo_numerics_06
entity_type: preference
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
scope: contexts
context_refs:
- pctx_demo_numerics
behavior: required
instruction: Save data, logs, and checkpoints under a unique run ID without overwriting
  other runs. Verify the model, parameters, and dependency versions before resuming
  a calculation.
condition: Saving results or continuing an existing job.
rationale: A fictional Demo user preference.
---
