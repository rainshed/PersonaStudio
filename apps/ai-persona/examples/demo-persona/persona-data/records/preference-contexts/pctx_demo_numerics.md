---
schema: ai-persona.preference-context/v1
id: pctx_demo_numerics
entity_type: preference_context
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
key: research.numerics
name: 数值计算
description: 为凝聚态物理问题设计、编写、运行或检查数值计算，包含电子结构计算、张量网络模拟与计算任务准备。仅解释概念时不触发。
activation:
  intents:
  - 用张量网络计算自旋链的时间演化
  - 检查收敛后准备提交一组参数扫描任务
  artifact_types:
  - julia
  - simulation-report
  excludes:
  - 只解释 MPS 的定义而不编写或运行计算
  - 只修改现有图片的字体与图例
---
