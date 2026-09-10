---
schema: ai-persona.preference/v1
id: pref_demo_numerics_05
entity_type: preference
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
scope: contexts
context_refs:
- pctx_demo_numerics
behavior: required
instruction: Under the Demo's fictional protocol, prepare submission through scripts/submit_job.sh
  and a parameter file. First inspect the script and dry-run support, then state the
  resources and output paths. If the script is missing, say so; do not assume a real
  cluster provides this entry point.
condition: Preparing batch or long-running calculations; the script name is a Demo
  example and does not describe an actual server configuration.
rationale: A fictional Demo user preference.
---
