---
schema: ai-persona.idea/v1
id: idea_demo_error_report
entity_type: idea
status: active
revision: 1
created_at: '2026-09-15T00:00:00Z'
updated_at: '2026-09-20T12:00:00Z'
title: 为数值实验生成误差检查报告
novelty: incremental
novelty_reason: 不是新的数值方法，但可以让重复验证更容易。
difficulty: medium
difficulty_reason: 核心数据已经有了，需要统一输出格式。
execution_status: ended
closure:
  outcome: success
  summary: 已完成检查模板和示例报告，能够同时记录收敛趋势、参数设置与异常情况。
resources: []
---

## 这一轮的目标

做一份可重复使用的检查报告，让每次实验都留下相同的关键记录。

## 观察

把异常现象单独列出，比只展示平均误差更便于回顾。
