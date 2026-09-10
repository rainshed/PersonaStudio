# Personal Preferences: 科研绘图

- Context key: `research.figure`
- Content hash: `sha256:7b17b856ec96a0c9bcbba2a1fd40f30cadada05875552a756e5c3129b20f8181`


## Required

- `pref_demo_figure_02` — 标明坐标轴的物理量与单位；图例说明参数组，误差条说明其统计含义。
  - When: 图中包含数据、参数分组或误差估计。
  - Why: 虚构的 Demo 用户偏好。
- `pref_demo_figure_04` — 保留原始数据和独立制图脚本，说明筛选、归一化与拟合区间，不为美观隐藏不一致结果。
  - When: 涉及数据处理或拟合。
  - Why: 虚构的 Demo 用户偏好。

## Preferred

- `pref_demo_figure_01` — 未指定输出格式时，适合栅格呈现的科研图优先输出 PNG；论文排版或明确要求矢量时提供 PDF/SVG。
  - When: 用户没有明确指定格式。
  - Why: 虚构的 Demo 用户偏好。
- `pref_demo_figure_03` — 同一物理量跨图保持一致配色，使用色觉友好的颜色并用线型辅助区分。
  - When: 需要比较多组数据或多幅图。
  - Why: 虚构的 Demo 用户偏好。

## Avoid

No active preferences.

## Reference Examples

- `pex_demo_figure_negative` — 科研绘图 · 反例 (negative)
  - File: `sources/src_demo_sample_figure_negative/original.md`
  - Original filename: `src_demo_sample_figure_negative`
  - Content hash: `sha256:f08520cda5b00f9c61286568a2a42c98ef9abf87bc37ef1a12e0f6b84c1933ff`
  - When: 为科研数据新建或实质性修改图表，包括比较曲线、标度分析和论文插图。仅讨论图中物理意义时不触发。
  - 对照本场景的规则检查信息、步骤与记录是否完整。
- `pex_demo_figure_positive` — 科研绘图 · 正例 (positive)
  - File: `sources/src_demo_sample_figure_positive/original.md`
  - Original filename: `src_demo_sample_figure_positive`
  - Content hash: `sha256:1591784a4fdf49c5a11c4e6be4ef203f6d119fd6d2b878a683e32344353b030f`
  - When: 为科研数据新建或实质性修改图表，包括比较曲线、标度分析和论文插图。仅讨论图中物理意义时不触发。
  - 对照本场景的规则检查信息、步骤与记录是否完整。

## Final Check

- [ ] 标明坐标轴的物理量与单位；图例说明参数组，误差条说明其统计含义。
- [ ] 保留原始数据和独立制图脚本，说明筛选、归一化与拟合区间，不为美观隐藏不一致结果。
