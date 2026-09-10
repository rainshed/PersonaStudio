# Personal Preferences: Numerical Computing

- Context key: `research.numerics`
- Content hash: `sha256:d8dde72546aa3330ef150f8a22123445215f4084e4fd1ce54bed2d750dcdc2ef`


## Required

- `pref_demo_numerics_02` — Validate small systems before large calculations. Where feasible, compare energies or representative observables with exact diagonalization, and check normalization and model conventions.
  - When: Adding an algorithm implementation or changing the model definition.
  - Why: A fictional Demo user preference.
- `pref_demo_numerics_03` — Check convergence separately with respect to bond dimension, truncation threshold, time step, and system size. Report the checks actually performed and the remaining errors.
  - When: Using approximate algorithms or interpreting physical results obtained from them.
  - Why: A fictional Demo user preference.
- `pref_demo_numerics_04` — Save the Julia version, Project.toml, Manifest.toml, random seeds, parameter files, and code version so results can be reproduced.
  - When: Running and saving numerical experiments.
  - Why: A fictional Demo user preference.
- `pref_demo_numerics_05` — Under the Demo's fictional protocol, prepare submission through scripts/submit_job.sh and a parameter file. First inspect the script and dry-run support, then state the resources and output paths. If the script is missing, say so; do not assume a real cluster provides this entry point.
  - When: Preparing batch or long-running calculations; the script name is a Demo example and does not describe an actual server configuration.
  - Why: A fictional Demo user preference.
- `pref_demo_numerics_06` — Save data, logs, and checkpoints under a unique run ID without overwriting other runs. Verify the model, parameters, and dependency versions before resuming a calculation.
  - When: Saving results or continuing an existing job.
  - Why: A fictional Demo user preference.

## Preferred

- `pref_demo_numerics_01` — Prefer the Julia ITensor ecosystem for tensor-network algorithms: ITensors.jl for basic tensor operations, and ITensorMPS.jl for MPS/MPO objects and related algorithms.
  - When: No other language or existing algorithm framework has been explicitly specified.
  - Why: A fictional Demo user preference.

## Avoid

No active preferences.

## Reference Examples

- `pex_demo_numerics_negative` — Numerical Computing · Negative Example (negative)
  - File: `sources/src_demo_sample_numerics_negative/original.md`
  - Original filename: `src_demo_sample_numerics_negative`
  - Content hash: `sha256:c501fa911ec7e313eb5ae193655c736d027e3d15b6c69b40f94e1504a66c0b05`
  - When: Design, write, run, or review numerical calculations for condensed matter physics, including electronic structure, tensor-network simulations, and preparation of computational jobs. Does not apply to conceptual explanations alone.
  - Use this context’s rules to check whether the information, steps, and records are complete.
- `pex_demo_numerics_positive` — Numerical Computing · Positive Example (positive)
  - File: `sources/src_demo_sample_numerics_positive/original.md`
  - Original filename: `src_demo_sample_numerics_positive`
  - Content hash: `sha256:b7d1bd46c91e0bc7cf4e77663ef08abdfa5e8b6a52ff61a2b0d1d1bd57c2c4e9`
  - When: Design, write, run, or review numerical calculations for condensed matter physics, including electronic structure, tensor-network simulations, and preparation of computational jobs. Does not apply to conceptual explanations alone.
  - Use this context’s rules to check whether the information, steps, and records are complete.

## Final Check

- [ ] Validate small systems before large calculations. Where feasible, compare energies or representative observables with exact diagonalization, and check normalization and model conventions.
- [ ] Check convergence separately with respect to bond dimension, truncation threshold, time step, and system size. Report the checks actually performed and the remaining errors.
- [ ] Save the Julia version, Project.toml, Manifest.toml, random seeds, parameter files, and code version so results can be reproduced.
- [ ] Under the Demo's fictional protocol, prepare submission through scripts/submit_job.sh and a parameter file. First inspect the script and dry-run support, then state the resources and output paths. If the script is missing, say so; do not assume a real cluster provides this entry point.
- [ ] Save data, logs, and checkpoints under a unique run ID without overwriting other runs. Verify the model, parameters, and dependency versions before resuming a calculation.
