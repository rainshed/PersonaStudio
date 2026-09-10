---
schema: ai-persona.preference-context/v1
id: pctx_demo_figure
entity_type: preference_context
status: active
revision: 1
created_at: '2026-09-01T00:00:00Z'
updated_at: '2026-09-01T00:00:00Z'
key: research.figure
name: 科研绘图
description: 为科研数据新建或实质性修改图表，包括比较曲线、标度分析和论文插图。仅讨论图中物理意义时不触发。
activation:
  intents:
  - 把有无自旋轨道耦合的能带画在同一张图上
  - 调整这张误差棒图的坐标轴和图例
  artifact_types:
  - png
  - pdf
  - svg
  excludes:
  - 解释一张已有图片而不修改图片
  - 制作与科研数据无关的宣传插画
---
