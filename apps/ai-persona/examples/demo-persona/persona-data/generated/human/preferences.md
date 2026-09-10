# Preferences

## Contexts

- **Academic Notes** — `research.note`; Write or substantially revise a Markdown note on a research topic, including conceptual explanations, method derivations, or analysis of results.
- **Numerical Computing** — `research.numerics`; Design, write, run, or review numerical calculations for condensed matter physics, including electronic structure, tensor-network simulations, and preparation of computational jobs. Does not apply to conceptual explanations alone.
- **Research Figures** — `research.figure`; Create or substantially revise plots of research data, including curve comparisons, scaling analyses, and publication figures. Does not apply when only discussing the physics in an existing figure.

## Preferences

### When no output format is specified, prefer PNG for research figures suited to raster output; provide PDF/SVG for publication layouts or explicit vector requests.

- Behavior: `preferred`
- Scope: Research Figures
- Status: `active`
- Condition: The user has not explicitly specified a format.
- Rationale: A fictional Demo user preference.
### Label axes with physical quantities and units; identify parameter groups in the legend and explain the statistical meaning of error bars.

- Behavior: `required`
- Scope: Research Figures
- Status: `active`
- Condition: The figure contains data, parameter groups, or uncertainty estimates.
- Rationale: A fictional Demo user preference.
### Use consistent colors for the same physical quantity across figures, choose colors accessible to readers with color-vision deficiencies, and add line styles to distinguish series.

- Behavior: `preferred`
- Scope: Research Figures
- Status: `active`
- Condition: Comparing multiple datasets or figures.
- Rationale: A fictional Demo user preference.
### Keep the original data and a standalone plotting script. Explain filtering, normalization, and fitting ranges, and do not hide inconsistent results for appearance.

- Behavior: `required`
- Scope: Research Figures
- Status: `active`
- Condition: Processing or fitting data.
- Rationale: A fictional Demo user preference.
### First query the Persona knowledge relevant to the topic. Clearly explain concepts that are unrecorded or rated only as aware, and connect them to existing knowledge.

- Behavior: `required`
- Scope: Academic Notes
- Status: `active`
- Condition: Writing a technical note for this Demo user.
- Rationale: A fictional Demo user preference.
### Define new symbols at first use, and explain the physical meaning, assumptions, and scope of equations in the surrounding prose.

- Behavior: `required`
- Scope: Academic Notes
- Status: `active`
- Condition: Introducing equations, abbreviations, or new notation.
- Rationale: A fictional Demo user preference.
### Develop arguments in connected paragraphs. Use lists for logical groupings, avoiding a separate line for every sentence and unnecessary line breaks.

- Behavior: `preferred`
- Scope: Academic Notes
- Status: `active`
- Condition: Organizing the body of a note.
- Rationale: A fictional Demo user preference.
### Distinguish conclusions from sources, your own derivations, and questions awaiting verification. Retain traceable source references when citing materials.

- Behavior: `required`
- Scope: Academic Notes
- Status: `active`
- Condition: Summarizing paper conclusions, numerical results, or conjectures.
- Rationale: A fictional Demo user preference.
### Prefer the Julia ITensor ecosystem for tensor-network algorithms: ITensors.jl for basic tensor operations, and ITensorMPS.jl for MPS/MPO objects and related algorithms.

- Behavior: `preferred`
- Scope: Numerical Computing
- Status: `active`
- Condition: No other language or existing algorithm framework has been explicitly specified.
- Rationale: A fictional Demo user preference.
### Validate small systems before large calculations. Where feasible, compare energies or representative observables with exact diagonalization, and check normalization and model conventions.

- Behavior: `required`
- Scope: Numerical Computing
- Status: `active`
- Condition: Adding an algorithm implementation or changing the model definition.
- Rationale: A fictional Demo user preference.
### Check convergence separately with respect to bond dimension, truncation threshold, time step, and system size. Report the checks actually performed and the remaining errors.

- Behavior: `required`
- Scope: Numerical Computing
- Status: `active`
- Condition: Using approximate algorithms or interpreting physical results obtained from them.
- Rationale: A fictional Demo user preference.
### Save the Julia version, Project.toml, Manifest.toml, random seeds, parameter files, and code version so results can be reproduced.

- Behavior: `required`
- Scope: Numerical Computing
- Status: `active`
- Condition: Running and saving numerical experiments.
- Rationale: A fictional Demo user preference.
### Under the Demo's fictional protocol, prepare submission through scripts/submit_job.sh and a parameter file. First inspect the script and dry-run support, then state the resources and output paths. If the script is missing, say so; do not assume a real cluster provides this entry point.

- Behavior: `required`
- Scope: Numerical Computing
- Status: `active`
- Condition: Preparing batch or long-running calculations; the script name is a Demo example and does not describe an actual server configuration.
- Rationale: A fictional Demo user preference.
### Save data, logs, and checkpoints under a unique run ID without overwriting other runs. Verify the model, parameters, and dependency versions before resuming a calculation.

- Behavior: `required`
- Scope: Numerical Computing
- Status: `active`
- Condition: Saving results or continuing an existing job.
- Rationale: A fictional Demo user preference.

## Reference Examples

- **Research Figures · Negative Example** — `negative`; contexts=Research Figures; file=`src_demo_sample_figure_negative`; status=`active` (`pex_demo_figure_negative`)
- **Research Figures · Positive Example** — `positive`; contexts=Research Figures; file=`src_demo_sample_figure_positive`; status=`active` (`pex_demo_figure_positive`)
- **Academic Notes · Negative Example** — `negative`; contexts=Academic Notes; file=`src_demo_sample_note_negative`; status=`active` (`pex_demo_note_negative`)
- **Academic Notes · Positive Example** — `positive`; contexts=Academic Notes; file=`src_demo_sample_note_positive`; status=`active` (`pex_demo_note_positive`)
- **Numerical Computing · Negative Example** — `negative`; contexts=Numerical Computing; file=`src_demo_sample_numerics_negative`; status=`active` (`pex_demo_numerics_negative`)
- **Numerical Computing · Positive Example** — `positive`; contexts=Numerical Computing; file=`src_demo_sample_numerics_positive`; status=`active` (`pex_demo_numerics_positive`)
