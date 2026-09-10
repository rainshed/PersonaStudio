# Personal Preferences: Research Figures

- Context key: `research.figure`
- Content hash: `sha256:a0bead9f3bf0269574b0e18203f9fd0caf2f81bcc6d8e8d8caebe7ee9e6c1d82`


## Required

- `pref_demo_figure_02` — Label axes with physical quantities and units; identify parameter groups in the legend and explain the statistical meaning of error bars.
  - When: The figure contains data, parameter groups, or uncertainty estimates.
  - Why: A fictional Demo user preference.
- `pref_demo_figure_04` — Keep the original data and a standalone plotting script. Explain filtering, normalization, and fitting ranges, and do not hide inconsistent results for appearance.
  - When: Processing or fitting data.
  - Why: A fictional Demo user preference.

## Preferred

- `pref_demo_figure_01` — When no output format is specified, prefer PNG for research figures suited to raster output; provide PDF/SVG for publication layouts or explicit vector requests.
  - When: The user has not explicitly specified a format.
  - Why: A fictional Demo user preference.
- `pref_demo_figure_03` — Use consistent colors for the same physical quantity across figures, choose colors accessible to readers with color-vision deficiencies, and add line styles to distinguish series.
  - When: Comparing multiple datasets or figures.
  - Why: A fictional Demo user preference.

## Avoid

No active preferences.

## Reference Examples

- `pex_demo_figure_negative` — Research Figures · Negative Example (negative)
  - File: `sources/src_demo_sample_figure_negative/original.md`
  - Original filename: `src_demo_sample_figure_negative`
  - Content hash: `sha256:930c79c8a36a1352529c2543c2ab6037f905b435f88586b0d95258bd33ca1d59`
  - When: Create or substantially revise plots of research data, including curve comparisons, scaling analyses, and publication figures. Does not apply when only discussing the physics in an existing figure.
  - Use this context’s rules to check whether the information, steps, and records are complete.
- `pex_demo_figure_positive` — Research Figures · Positive Example (positive)
  - File: `sources/src_demo_sample_figure_positive/original.md`
  - Original filename: `src_demo_sample_figure_positive`
  - Content hash: `sha256:8130a2a5c31ac871d6313fa827384a3a8de19f2e90238a8f4f3eb9db7f379344`
  - When: Create or substantially revise plots of research data, including curve comparisons, scaling analyses, and publication figures. Does not apply when only discussing the physics in an existing figure.
  - Use this context’s rules to check whether the information, steps, and records are complete.

## Final Check

- [ ] Label axes with physical quantities and units; identify parameter groups in the legend and explain the statistical meaning of error bars.
- [ ] Keep the original data and a standalone plotting script. Explain filtering, normalization, and fitting ranges, and do not hide inconsistent results for appearance.
