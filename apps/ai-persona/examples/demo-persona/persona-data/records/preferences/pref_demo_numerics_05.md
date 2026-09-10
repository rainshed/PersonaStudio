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
instruction: 按 Demo 的虚构协议，通过 scripts/submit_job.sh 与参数文件准备提交；先检查脚本和 dry-run 能力，说明资源与输出路径。脚本缺失时明确说明，不假定真实集群存在此入口。
condition: 准备提交批量或长时间计算；脚本名仅为 Demo 示例，不代表实际服务器配置。
rationale: 虚构的 Demo 用户偏好。
---
