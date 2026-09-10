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
instruction: 使用独立 run ID 保存数据、日志和 checkpoint，不覆盖其他运行；恢复计算前核对模型、参数和依赖版本。
condition: 保存结果或继续已有任务。
rationale: 虚构的 Demo 用户偏好。
---
