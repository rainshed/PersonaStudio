---
schema: ai-persona.evidence/v1
id: ev_demo_note
entity_type: evidence
source_id: src_demo_note
source_hash: sha256:aead652fe04a2fe64050ddb8dd3fb9034322b232756eb9fa39fac0e6ff741244
locator:
  file: original.md
  heading: 用 TEBD 理解一维量子系统的实时演化
  line_start: 1
  line_end: 9
supports:
  - mat_demo_tebd_note
  - rel_demo_material_covers_tebd
  - rel_demo_material_covers_noneq
evidence_kind: authored_material
extraction_method: human_demo_fixture
confidence: 1.0
status: active
revision: 1
created_at: 2026-09-01T12:00:00Z
updated_at: 2026-09-01T12:00:00Z
---

# 用 TEBD 理解一维量子系统的实时演化

## 问题

我们希望计算一维局域哈密顿量下的量子态实时演化，同时控制矩阵乘积态的键维数。

## 方法

TEBD 使用 Suzuki–Trotter 分解把时间演化算符拆成局域门。每次作用局域门后，通过奇异值分解恢复 MPS 形式，并根据截断误差控制键维数。
