---
schema: ai-persona.preference-context/v1
id: pctx_demo_numerics
entity_type: preference_context
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
key: research.numerics
name: Numerical Computing
description: Design, write, run, or review numerical calculations for condensed matter
  physics, including electronic structure, tensor-network simulations, and preparation
  of computational jobs. Does not apply to conceptual explanations alone.
activation:
  intents:
  - Compute the time evolution of a spin chain using tensor networks
  - Check convergence, then prepare a batch of parameter-scan jobs
  artifact_types:
  - julia
  - simulation-report
  excludes:
  - Explain the definition of an MPS without writing or running a calculation
  - Only change fonts and legends in an existing figure
---
