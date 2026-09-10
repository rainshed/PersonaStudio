# Demo Persona

This is the read-only `condensed-matter-v4` distribution template bundled with the Python package. The application copies it into a dedicated workspace before running it. All sample content is in English, including knowledge records, articles, preferences, and reference examples.

## Fictional researcher

A doctoral researcher studying two-dimensional magnetic and topological materials, familiar with crystal structures and DFT, and able to build tight-binding models. They are learning Berry geometry, spin waves, and superconductivity. The articles, knowledge levels, and reading history are independently authored fictional content.

The 30 knowledge nodes include one root domain and the following five branches (branch titles also count as nodes):

| Branch | Count | Child topics |
| --- | ---: | --- |
| Crystal Structure and Lattice Dynamics | 5 | Bravais lattices and primitive cells, reciprocal lattices and Brillouin zones, Bloch's theorem, phonons and dynamical matrices |
| Electronic Structure Calculations | 7 | Tight-binding models, Fermi surfaces, density of states and orbital projections, DFT, Kohn–Sham equations, Wannier functions and band interpolation |
| Local Moments and Magnetism | 5 | Exchange interactions, Heisenberg spin models, linear spin-wave theory, magnetic anisotropy |
| Topological Band Theory | 6 | Berry phase and curvature, Chern numbers, integer quantum Hall effect, time-reversal-symmetric topological insulators, spin-orbit coupling |
| Superconductivity | 6 | Cooper pairing, BCS theory, BdG equations, Ginzburg–Landau theory, type-II superconductors and flux vortices |

## Contents

- 30 independently authored knowledge nodes rooted in condensed matter physics, with fictional knowledge and interest levels.
- 5 original example articles with complete Markdown sources, source hashes, material relationships, and evidence locators.
- 68 relations connecting the knowledge hierarchy, prerequisites, applications, and article topics.
- 3 preference contexts, each with a positive and a negative example, for 6 reference samples in total.

| Context | Rules | Main topics |
| --- | ---: | --- |
| Research Figures | 4 | Output formats, axes and uncertainty, colors, data and plotting scripts |
| Academic Notes | 4 | Explanations adapted to existing knowledge, symbol definitions, connected paragraphs, sources and open questions |
| Numerical Computing | 6 | Julia ITensor, small-system benchmarks, convergence, reproducible environments, submission protocols, run records |

Numerical computing distinguishes the roles of `ITensors.jl` and `ITensorMPS.jl`; see the [official ITensorMPS tutorial](https://itensor.github.io/ITensorMPS.jl/stable/tutorials/DMRG.html). Names such as `scripts/submit_job.sh` and `configs/small.toml` are **fictional Demo project conventions**. No cluster submission script is installed. The rules require checking scripts and parameters first and prohibit pretending that a job has been submitted.

## Try it

Run in an environment where the project is installed:

```bash
ai-persona start --demo
```

The preferred address is <http://127.0.0.1:8766>; if the port is occupied, the launcher selects an available port. Suggested walkthrough:

1. Open My Knowledge to explore the five research branches and the relationships between Wannier functions, tight-binding models, and topological bands. Edit a node's knowledge level.
2. In Materials, open “From DFT Bands to Wannier Effective Models” and inspect its source text and related knowledge.
3. In My Preferences, review the activation conditions, rules, and positive and negative examples for all three contexts.
4. After configuring a separate Demo model connection, open `/preferences/try` and enter “Compute the time evolution of a spin chain using tensor networks” to inspect matches for Numerical Computing.
5. Propose a change in the AI maintenance assistant, confirm it through feedback and review, and check the updated Demo record.

## Isolation and data locations

- Template: `persona-data/` in this directory. Interactive use does not modify it.
- Editable copy: `~/.local/share/ai-persona/demo/condensed-matter-v4/` by default. `XDG_DATA_HOME` and `AI_PERSONA_DEMO_HOME` can change the parent directory.
- Demo data, indexes, drafts, evaluations, model accounts, and runtime logs stay in the editable copy. General model-weight caches may be shared with normal workspaces.
- Restarting preserves edits within the current Demo version. The English Demo uses a new directory; earlier `condensed-matter-v3` and `research-v2` copies are preserved separately. Start the Demo again after updating to open the English version.
- The Demo does not install real Hooks, capture real conversations, or inherit remote-access settings from the normal Studio. It supports its own MCP queries and proposals awaiting review.
- `ai-persona stop --demo` stops only the current Demo Studio; `ai-persona models-stop --demo` stops only its model service.
- Demo MCP uses `ai-persona-mcp --demo`. Review links prefer the verified address of the same Demo Studio, falling back to port 8766 when it is not running. An explicit `--review-base-url` is also supported.

## Maintenance

From the application source directory, run `PYTHONPATH=src .venv/bin/python scripts/build_demo.py` to rebuild the distribution template deterministically. The script contains only public fictional examples and reads no real user directories. The older, smaller dataset remains in `tests/fixtures/legacy-demo` as a fixed regression fixture and is excluded from Demo runtime and wheel distribution.
