# 用 TEBD 理解一维量子系统的实时演化

一篇展示用户偏好结构、公式解释和开放问题记录方式的研究 Note。

## Abstract

No source abstract recorded.

## Bibliography

- Type: `note`
- Authors: Unknown
- Published: 2026-09-01
- Venue: Personal Research Note
- Language: zh
- arXiv: None
- DOI: None
- ISBN: None
- Canonical URL: None

## My Reading

- Relationships: authored, studied
- Understanding: `familiar`
- Preference: `favorite`
- Scope: 该水平只描述用户对这篇材料的熟悉程度，不替代 TEBD 知识节点水平。

## Preference Reasons

- **research-direction** — 这份 Note 记录了我关心的一维量子系统实时演化问题。
- **writing-style** — 它保留了公式解释、个人理解和后续开放问题。

## Knowledge Connections

- **TEBD** — method; primary: 这份 Note 使用 TEBD 理解并计算一维量子系统的实时演化。 (`rel_demo_material_covers_tebd`)
  - Evidence `ev_demo_note` from `src_demo_note` at `{"file": "original.md", "heading": "用 TEBD 理解一维量子系统的实时演化", "line_end": 9, "line_start": 1}`
    > # 用 TEBD 理解一维量子系统的实时演化
    >
    > ## 问题
    >
    > 我们希望计算一维局域哈密顿量下的量子态实时演化，同时控制矩阵乘积态的键维数。
    >
    > ## 方法
    >
    > TEBD 使用 Suzuki–Trotter 分解把时间演化算符拆成局域门。每次作用局域门后，通过奇异值分解恢复 MPS 形式，并根据截断误差控制键维数。
- **非平衡量子动力学** — topic; primary: 这份 Note 以一维量子系统的非平衡实时演化为主要研究主题。 (`rel_demo_material_covers_noneq`)
  - Evidence `ev_demo_note` from `src_demo_note` at `{"file": "original.md", "heading": "用 TEBD 理解一维量子系统的实时演化", "line_end": 9, "line_start": 1}`
    > # 用 TEBD 理解一维量子系统的实时演化
    >
    > ## 问题
    >
    > 我们希望计算一维局域哈密顿量下的量子态实时演化，同时控制矩阵乘积态的键维数。
    >
    > ## 方法
    >
    > TEBD 使用 Suzuki–Trotter 分解把时间演化算符拆成局域门。每次作用局域门后，通过奇异值分解恢复 MPS 形式，并根据截断误差控制键维数。

## Tags

物理学, 量子动力学, 张量网络, 研究 Note

## Personal Notes

# Personal Notes

## Why I saved this

这是我整理的一份研究 Note，能代表我理解和记录量子动力学问题的方式。

## Key takeaways

- TEBD 适合处理一维量子系统的实时演化。
- 使用截断时需要持续关注纠缠增长和数值误差。

## Connections to my work

它连接了张量网络数值方法和非平衡量子动力学。

## Open questions

- 在长时间演化中，如何更可靠地评估截断误差？

## Possible directions

- 比较 TEBD 与其他张量网络实时演化方法的适用范围。

## Source

- Source ID: `src_demo_note`
- Original: `sources/src_demo_note/original.md`
- Provider: manual
- Version: 1
- URL: None
- Content hash: `sha256:aead652fe04a2fe64050ddb8dd3fb9034322b232756eb9fa39fac0e6ff741244`
- Files:
  - `original.md` — original; text/markdown; sha256:aead652fe04a2fe64050ddb8dd3fb9034322b232756eb9fa39fac0e6ff741244

## Record

- ID: `mat_demo_tebd_note`
- Revision: `1`
- Updated: `2026-09-01T12:00:00Z`
