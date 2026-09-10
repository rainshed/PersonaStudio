---
schema: ai-persona.preference/v1
id: pref_demo_numerics_01
entity_type: preference
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
scope: contexts
context_refs:
- pctx_demo_numerics
behavior: preferred
instruction: 张量网络算法优先采用 Julia 的 ITensor 生态：基础张量操作使用 ITensors.jl，MPS/MPO 与相关算法使用 ITensorMPS.jl。
condition: 没有明确指定其他语言或既有算法框架。
rationale: 虚构的 Demo 用户偏好。
---
