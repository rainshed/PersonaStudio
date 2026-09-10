"""Rebuild the public, synthetic research Demo; never read a private workspace."""
from __future__ import annotations

import hashlib
import json
import shutil
import tempfile
from pathlib import Path

import yaml

from ai_persona.compiler import PersonaCompiler
from ai_persona.demo import DEMO_METADATA, DEMO_VERSION
from ai_persona.frontmatter import dump_markdown_record
from ai_persona.initialization import REQUIRED_DIRECTORIES
from ai_persona.models import (
    Evidence,
    KnowledgeNode,
    Material,
    Preference,
    PreferenceContext,
    PreferenceExample,
    Relation,
    SourceManifest,
    Tag,
)

STAMP = "2026-09-01T00:00:00Z"
TARGET = Path(__file__).resolve().parents[1] / "examples/demo-persona/persona-data"

# slug, title, role, domain, mastery, interest, summary, parent
# Fictional doctoral researcher: two-dimensional magnetic and topological materials.
# This catalog is authored independently; no private Persona is read or imported.
KNOWLEDGE = [
    ("condensed", "Condensed Matter Physics", "domain", "physics", "familiar", "high",
     "Understand collective material properties through electronic, lattice, and magnetic degrees of freedom in crystals.", None),
    ("crystal", "Crystal Structure and Lattice Dynamics", "area", "physics", "proficient", "medium",
     "Build the geometric foundation for materials calculations from periodic structures, symmetry, and atomic vibrations.", "condensed"),
    ("bravais", "Bravais Lattices and Primitive Cells", "concept", "physics", "proficient", "medium",
     "Distinguish the translation lattice, basis, and primitive cell, and reconstruct periodic structures from lattice vectors.", "crystal"),
    ("reciprocal", "Reciprocal Lattices and Brillouin Zones", "concept", "physics", "proficient", "high",
     "Construct reciprocal basis vectors and high-symmetry paths, and check momentum coordinates across unit-cell conventions.", "crystal"),
    ("bloch", "Bloch's Theorem", "theory", "physics", "proficient", "high",
     "Represent crystal electron states as a periodic function times a plane wave, and understand momentum labels for energy bands.", "crystal"),
    ("phonon", "Phonons and Dynamical Matrices", "concept", "physics", "familiar", "medium",
     "Understand vibrational modes through the harmonic dynamical matrix, and check imaginary frequencies and structural stability.", "crystal"),
    ("electronic", "Electronic Structure Calculations", "area", "physics", "proficient", "high",
     "Connect crystal structure and orbital character to energy bands, focusing on low-energy electronic states in two-dimensional materials.", "condensed"),
    ("tight_binding", "Tight-Binding Models", "model", "physics", "proficient", "high",
     "Build effective Hamiltonians from local orbitals, on-site energies, and hopping parameters, checking orbital and phase conventions.", "electronic"),
    ("fermi_surface", "Fermi Surfaces", "concept", "physics", "familiar", "high",
     "Analyze Fermi-surface shapes, electron pockets, and hole pockets in metallic bands at a specified chemical potential.", "electronic"),
    ("dos", "Density of States and Orbital Projections", "technique", "physics", "proficient", "high",
     "Compare total and orbital-projected densities of states, separating the effects of broadening, sampling, and projection definitions.", "electronic"),
    ("dft", "Density Functional Theory (DFT)", "method", "physics", "proficient", "high",
     "Know the workflow for ground-state electron-density calculations and check functionals, pseudopotentials, and numerical convergence.", "electronic"),
    ("kohn_sham", "Kohn–Sham Equations", "theory", "physics", "familiar", "high",
     "Understand the self-consistent solution of an effective single-particle problem and the role of approximate exchange-correlation functionals.", "electronic"),
    ("wannier", "Wannier Functions and Band Interpolation", "method", "physics", "familiar", "high",
     "Construct effective models with localized orbitals, checking projections, energy windows, and interpolation against the target bands.", "electronic"),
    ("magnetism", "Local Moments and Magnetism", "area", "physics", "familiar", "high",
     "Understand magnetic order, exchange interactions, and low-energy spin excitations in two-dimensional magnetic materials.", "condensed"),
    ("exchange", "Exchange Interactions", "concept", "physics", "familiar", "high",
     "Distinguish sign conventions, neighbor ranges, and spin normalization when fitting effective exchange parameters.", "magnetism"),
    ("heisenberg", "Heisenberg Spin Models", "model", "physics", "familiar", "high",
     "Describe magnetism through exchange couplings between spins, comparing magnetic configurations and the model's range of validity.", "magnetism"),
    ("spin_wave", "Linear Spin-Wave Theory", "method", "physics", "aware", "high",
     "Learn to derive magnon spectra by expanding around an ordered state, and check the limits of the approach when fluctuations are large.", "magnetism"),
    ("anisotropy", "Magnetic Anisotropy", "concept", "physics", "familiar", "high",
     "Analyze energy differences between magnetization directions, distinguishing single-ion, exchange, and shape anisotropy.", "magnetism"),
    ("topology", "Topological Band Theory", "area", "physics", "aware", "high",
     "Extend conventional band analysis to geometric phases, topological invariants, and boundary states.", "condensed"),
    ("berry", "Berry Phase and Berry Curvature", "concept", "physics", "aware", "high",
     "Know the idea of geometric phase in parameter space, and learn gauge choices and calculations on discrete momentum grids.", "topology"),
    ("chern", "Chern Numbers", "concept", "physics", "aware", "high",
     "Study topological invariants of two-dimensional bands, checking the occupied subspace, energy gap, and numerical integration convergence.", "topology"),
    ("quantum_hall", "Integer Quantum Hall Effect", "topic", "physics", "familiar", "medium",
     "Understand the basic picture of quantized Hall response and continue learning its connection to band topology.", "topology"),
    ("topological_insulator", "Time-Reversal-Symmetric Topological Insulators", "topic", "physics", "aware", "high",
     "Study the connection between bulk gaps, protecting symmetries, and boundary states, distinguishing Z₂ indices from Chern numbers.", "topology"),
    ("spin_orbit", "Spin-Orbit Coupling", "concept", "physics", "familiar", "high",
     "Include the coupling of spin and orbital degrees of freedom in electronic structure, and analyze band splitting and magnetic anisotropy.", "topology"),
    ("superconductivity", "Superconductivity", "area", "physics", "aware", "medium",
     "Explore pairing, order parameters, quasiparticles, and electromagnetic response as a new research direction.", "condensed"),
    ("cooper", "Cooper Pairing", "concept", "physics", "aware", "medium",
     "Learn the basic picture of electron pairing near the Fermi surface, distinguishing pair formation from macroscopic coherence.", "superconductivity"),
    ("bcs", "BCS Theory", "theory", "physics", "aware", "high",
     "Learn the mean-field description of weak-coupling pairing, including the energy gap, self-consistency conditions, and theoretical assumptions.", "superconductivity"),
    ("bdg", "Bogoliubov–de Gennes Equations", "method", "physics", "aware", "high",
     "Learn to solve superconducting mean-field quasiparticle problems in a basis of particle and hole components.", "superconductivity"),
    ("ginzburg_landau", "Ginzburg–Landau Theory", "theory", "physics", "aware", "medium",
     "Understand spatial variations in superconductivity through order-parameter free energy, noting phenomenological parameters and the applicable temperature range.", "superconductivity"),
    ("vortex", "Type-II Superconductors and Flux Vortices", "topic", "physics", "unspecified", "medium",
     "Not yet studied systematically; plan to begin with penetration depth, coherence length, and magnetic flux quantization.", "superconductivity"),
]

ARTICLES = [
    ("crystal", "From Primitive Cells to Phonon Spectra: A Starting Point for 2D Materials",
     ["crystal", "bravais", "reciprocal", "bloch", "phonon"],
     "Connect unit cells, momentum coordinates, and vibrational modes to structural checks for two-dimensional materials.", """
# From Primitive Cells to Phonon Spectra: A Starting Point for 2D Materials

> An original fictional AI Persona example. The researcher, reading history, and exercise plans are invented for the Demo; this article reports no real materials discoveries.

## Define the structure first

The researcher plans to study a hypothetical two-dimensional magnetic layer. Before calculating anything, they record the primitive lattice vectors, atomic positions in the basis, and the vacuum spacing used to simulate the layer. The lattice describes periodic translations, while the basis describes the structure attached to each lattice point. A honeycomb arrangement should not be treated as a monatomic Bravais lattice without explaining its basis.

## Coordinate conventions in reciprocal space

Let aᵢ denote the real-space primitive vectors and bⱼ the reciprocal basis vectors, using the convention aᵢ·bⱼ=2πδᵢⱼ, where δᵢⱼ is the Kronecker delta. Fractional coordinates of high-symmetry points depend on the chosen reciprocal basis. Reusing old labels after changing the cell, without checking the actual path, can make two band plots unsuitable for direct comparison.

Bloch's theorem expresses an electron state in a periodic potential as a plane-wave factor times a periodic function. It explains why bands can be organized within the Brillouin zone, but does not guarantee that an arbitrary high-symmetry path passes through every band extremum.

## How to handle imaginary phonon frequencies

In the harmonic approximation, phonon frequencies follow from the eigenvalue problem of the dynamical matrix. If imaginary frequencies appear, first check structural relaxation and convergence of force constants and sampling, then consider possible structural instabilities. Flexural modes near Γ in two-dimensional materials require careful treatment of numerical errors. A small region of negative plotted frequencies alone does not establish a new phase.

## Keep inputs traceable

This exercise retains the original and relaxed structures, coordinate conventions, and phonon calculation parameters. Plots label the path and frequency units so that the effects of strain and magnetic configurations can be compared later. These are planned checks, with no fabricated calculation outputs.
"""),
    ("bands", "From DFT Bands to Wannier Effective Models",
     ["electronic", "tight_binding", "fermi_surface", "dos", "dft", "kohn_sham", "wannier"],
     "Organize bands, densities of states, and local-orbital models from self-consistent electronic structure calculations.", """
# From DFT Bands to Wannier Effective Models

> An original fictional AI Persona example. Software documentation links provide methodological references; this article contains no parameters or data from a real project.

## Research task and existing background

The hypothetical task is to understand orbital character near the Fermi energy of a two-dimensional material. The researcher is comfortable with DFT workflows but is still gaining experience with Wannier modeling. The note should start from familiar band plots, explain why a local-orbital representation is useful, and show how it supports denser momentum sampling.

## Record self-consistency and post-processing separately

A Kohn–Sham DFT calculation updates the electron density through an effective single-particle problem until the chosen self-consistency conditions are satisfied. The exercise records the exchange-correlation functional, pseudopotentials, spin settings, and convergence thresholds. Band-path and density-of-states calculations serve different sampling purposes. Post-processing should use a converged density, and a high-symmetry path alone should not be used to estimate the total density of states.

Energy plots consistently use E−E_F, where E is the plotted band energy and E_F is the Fermi-energy reference for that result. Comparisons between calculations must explain energy alignment. The position of the Fermi energy in an insulator should not be treated as a universal reference without clarification.

## From orbital projections to an effective model

Tight-binding models use local orbitals, on-site energies, and hopping matrix elements. Wannier functions provide a way to construct a localized representation of a selected band subspace. The researcher should record the initial projections and energy windows, then overlay interpolated bands with the original calculation. A reduction in orbital spread does not replace accuracy checks within the target energy window.

For metals, also check whether crossings and small pockets near the Fermi surface are stable. For orbital-projected densities of states, state the projection convention. Use the model for subsequent analysis only within the energy and parameter ranges that have been validated.

## Exercise deliverables

The planned deliverables are a parameter table, a comparison plot of original and interpolated bands, and an account of fitting errors. The exercise specifies no unverified optimal parameters and does not claim that software has already been run.

References: [Quantum ESPRESSO electronic structure calculation guide](https://www.quantum-espresso.org/Doc/pw_user_guide/node10.html); [Wannier90 localized-orbital tutorial](https://wannier90.readthedocs.io/en/latest/tutorials/tutorial_1/).
"""),
    ("magnetism", "From Magnetic Configuration Energies to Spin Waves: A Modeling Note",
     ["magnetism", "exchange", "heisenberg", "spin_wave", "anisotropy"],
     "Organize a model of a hypothetical two-dimensional magnet around exchange parameters, magnetic anisotropy, and spin waves.", """
# From Magnetic Configuration Energies to Spin Waves: A Modeling Note

> An original fictional AI Persona example. The magnetic configuration comparisons and calculation plans below have not been carried out and do not describe a real sample.

## Magnetic models begin with conventions

The researcher wants to map energy differences between magnetic configurations onto effective exchange parameters. They use H=∑⟨ij⟩Jᵢⱼ Sᵢ·Sⱼ, where H is the model Hamiltonian, Sᵢ is the spin at site i, and each selected bond is counted once. Under this sign convention, positive J favors antiparallel alignment. If a reference uses the opposite Hamiltonian sign, its interpretation of positive and negative exchange parameters cannot be copied directly.

Before fitting, also specify the spin length and neighbor range. Different parameter sets may explain the same finite set of energy differences. Additional independent configurations and prediction-error checks help determine whether the effective model is adequate.

## Anisotropy in two-dimensional magnets

Alongside isotropic exchange, the example plans to compare energies for different magnetization directions. Magnetic anisotropy can have several origins, so distinguish single-ion terms, anisotropic exchange, and shape effects. A single energy difference does not automatically account for every magnetic mechanism, and zero-temperature energy comparisons alone do not directly determine a transition temperature.

## From an ordered state to spin waves

The researcher is familiar with Heisenberg models but has only an introductory understanding of linear spin-wave theory. The note therefore explains expansion around a candidate ordered state before introducing magnon dispersion. If the reference state is unstable or quantum fluctuations are strong, the linear approximation must be reassessed.

## A numerical exercise to carry out

Use a small system first to check model signs and boundary conditions. If choosing tensor-network methods, follow the Demo preference for Julia's ITensors.jl and ITensorMPS.jl, then check bond dimension, truncation threshold, and system size. Scan the time step only when time evolution is involved.

The hypothetical project uses scripts/submit_job.sh with configs/small.toml. In actual work, first confirm that the script exists and read its parameter documentation. If it supports a dry run, check the requested resources and output locations. This article installs no submission script and has submitted no jobs to any cluster.
"""),
    ("topology", "How to Determine Whether Bands Are Topologically Nontrivial",
     ["topology", "berry", "chern", "quantum_hall", "topological_insulator", "spin_orbit"],
     "Introduce geometric phases, occupied subspaces, and protecting symmetries from familiar band concepts, avoiding classifications based on appearance alone.", """
# How to Determine Whether Bands Are Topologically Nontrivial

> An original fictional AI Persona example. This article outlines a learning path and does not classify any real material.

## From familiar bands to unfamiliar geometric information

The researcher can already interpret bands and orbital projections but is new to Berry geometry. The note first explains that energy eigenvalues do not contain all the information about how eigenstates vary with momentum. Geometric phases concern changes of states in parameter space. For an isolated band, a local gauge defines the Berry connection Aₙ(k)=i⟨uₙₖ|∇ₖuₙₖ⟩, where k is crystal momentum, n is the band index, and uₙₖ is the periodic part of the Bloch state.

## From curvature to a topological index

Berry curvature is the curl of the connection. In an appropriate gapped two-dimensional band problem, integrating the occupied-state curvature over the full Brillouin zone gives a Chern number with the proper normalization. A numerical calculation should specify the occupied subspace and gap, then check grid convergence and the treatment of degeneracies. Plotting curvature only along a high-symmetry path cannot replace integration over the full Brillouin zone.

## Symmetry determines the relevant question

The integer quantum Hall effect helps connect Chern topology to response. For time-reversal-symmetric systems of spinful electrons, the applicable Z₂ classification must also be considered. A zero total Chern number does not automatically imply a trivial phase in that classification. Spin-orbit coupling can change bands and the structures allowed by symmetry, but its presence alone is not a topological criterion.

## Build an assessment that can be reviewed

The example report first specifies the Hamiltonian or effective model, filling, and protecting symmetries, then selects the appropriate invariant and checks whether the boundary spectrum agrees with the bulk properties. Band inversion and boundary-state plots offer clues, but the gap, boundary termination, and stability checks should be stated. Every step not yet carried out remains part of the learning plan.

Reference: [Topology in condensed matter: the Haldane model, Berry curvature, and Chern numbers](https://topocondmat.org/w4-haldane/haldane-model/).
"""),
    ("superconductivity", "A Route into Superconductivity for Band-Structure Researchers",
     ["superconductivity", "cooper", "bcs", "bdg", "ginzburg_landau", "vortex"],
     "Introduce superconductivity through pairing, quasiparticles, and order parameters, adapting explanations to different levels of familiarity.", """
# A Route into Superconductivity for Band-Structure Researchers

> An original fictional AI Persona example. Learning progress is assigned for demonstration and does not represent any real user's research experience.

## Establish the starting point

The researcher is familiar with Bloch states and electronic structure calculations and is just beginning superconductivity. They have heard of Cooper pairing and BCS theory but have not systematically studied flux vortices. This note therefore connects the Fermi surface to pairing, introduces quasiparticles, and leaves electromagnetic response as an advanced topic.

## From pairing to mean field

In the simplest uniform, single-band, s-wave BCS mean-field description, quasiparticle energies take the form Eₖ=√(ξₖ²+|Δ|²). Here k is momentum, ξₖ is the normal-state energy relative to the chemical potential, and Δ is the pairing gap parameter. This expression comes with model assumptions and approximations; it cannot be directly generalized to the complete excitation spectrum of every superconducting material.

Pair formation and macroscopic coherence are distinct questions. After understanding the mean-field result, study when phase fluctuations matter, rather than treating a nonzero input Δ as proof that a material has become superconducting.

## Why introduce the BdG equations?

The Bogoliubov–de Gennes method treats superconducting mean-field problems in a basis containing particle and hole components. It is useful for spatially inhomogeneous pairing, but a solution must still specify the normal-state model, pairing form, boundary conditions, and whether the gap is imposed or determined self-consistently. The note defines the basis before explaining the blocks of the matrix.

## Order parameters and flux vortices

Ginzburg–Landau theory organizes spatial variations in superconductivity through an order-parameter free energy, describing coherence length and magnetic penetration within its range of validity. Familiarity with type-II superconductors and vortices has not yet been recorded in this profile, so introduce order-parameter phase and flux quantization before proceeding. This article invents no critical fields, transition temperatures, or numerical results.

The next exercise is to compare sign conventions in a uniform BCS model and a simple BdG model, and state their shared assumptions. This is a pending plan; no calculations have been performed.
"""),
]

CONTEXTS = [
    ("figure", "research.figure", "Research Figures",
     "Create or substantially revise plots of research data, including curve comparisons, scaling analyses, and publication figures. Does not apply when only discussing the physics in an existing figure.",
     ["Plot the bands with and without spin-orbit coupling in the same figure", "Adjust the axes and legend of this error-bar plot"],
     ["Explain an existing image without modifying it", "Create promotional illustrations unrelated to research data"], ["png", "pdf", "svg"], [
         ("preferred", "When no output format is specified, prefer PNG for research figures suited to raster output; provide PDF/SVG for publication layouts or explicit vector requests.", "The user has not explicitly specified a format."),
         ("required", "Label axes with physical quantities and units; identify parameter groups in the legend and explain the statistical meaning of error bars.", "The figure contains data, parameter groups, or uncertainty estimates."),
         ("preferred", "Use consistent colors for the same physical quantity across figures, choose colors accessible to readers with color-vision deficiencies, and add line styles to distinguish series.", "Comparing multiple datasets or figures."),
         ("required", "Keep the original data and a standalone plotting script. Explain filtering, normalization, and fitting ranges, and do not hide inconsistent results for appearance.", "Processing or fitting data."),
     ]),
    ("note", "research.note", "Academic Notes",
     "Write or substantially revise a Markdown note on a research topic, including conceptual explanations, method derivations, or analysis of results.",
     ["Write a note introducing Berry curvature from band-structure concepts", "Turn this Wannier band-interpolation check into an academic note"],
     ["Translate a single term", "Write promotional copy for an entirely different audience"], ["markdown"], [
         ("required", "First query the Persona knowledge relevant to the topic. Clearly explain concepts that are unrecorded or rated only as aware, and connect them to existing knowledge.", "Writing a technical note for this Demo user."),
         ("required", "Define new symbols at first use, and explain the physical meaning, assumptions, and scope of equations in the surrounding prose.", "Introducing equations, abbreviations, or new notation."),
         ("preferred", "Develop arguments in connected paragraphs. Use lists for logical groupings, avoiding a separate line for every sentence and unnecessary line breaks.", "Organizing the body of a note."),
         ("required", "Distinguish conclusions from sources, your own derivations, and questions awaiting verification. Retain traceable source references when citing materials.", "Summarizing paper conclusions, numerical results, or conjectures."),
     ]),
    ("numerics", "research.numerics", "Numerical Computing",
     "Design, write, run, or review numerical calculations for condensed matter physics, including electronic structure, tensor-network simulations, and preparation of computational jobs. Does not apply to conceptual explanations alone.",
     ["Compute the time evolution of a spin chain using tensor networks", "Check convergence, then prepare a batch of parameter-scan jobs"],
     ["Explain the definition of an MPS without writing or running a calculation", "Only change fonts and legends in an existing figure"], ["julia", "simulation-report"], [
         ("preferred", "Prefer the Julia ITensor ecosystem for tensor-network algorithms: ITensors.jl for basic tensor operations, and ITensorMPS.jl for MPS/MPO objects and related algorithms.", "No other language or existing algorithm framework has been explicitly specified."),
         ("required", "Validate small systems before large calculations. Where feasible, compare energies or representative observables with exact diagonalization, and check normalization and model conventions.", "Adding an algorithm implementation or changing the model definition."),
         ("required", "Check convergence separately with respect to bond dimension, truncation threshold, time step, and system size. Report the checks actually performed and the remaining errors.", "Using approximate algorithms or interpreting physical results obtained from them."),
         ("required", "Save the Julia version, Project.toml, Manifest.toml, random seeds, parameter files, and code version so results can be reproduced.", "Running and saving numerical experiments."),
         ("required", "Under the Demo's fictional protocol, prepare submission through scripts/submit_job.sh and a parameter file. First inspect the script and dry-run support, then state the resources and output paths. If the script is missing, say so; do not assume a real cluster provides this entry point.", "Preparing batch or long-running calculations; the script name is a Demo example and does not describe an actual server configuration."),
         ("required", "Save data, logs, and checkpoints under a unique run ID without overwriting other runs. Verify the model, parameters, and dependency versions before resuming a calculation.", "Saving results or continuing an existing job."),
     ]),
]

SAMPLES = {
    "figure": (
        "# Positive Example: A Reproducible Research Figure\n\nDeliver bands.png with a Γ–M–K–Γ horizontal axis stating the unit-cell convention, and a vertical axis labeled E−E_F (eV). Explain the E_F reference and energy alignment. Use consistent colors and distinct line styles for bands with and without spin-orbit coupling. Keep the original band data and plot_bands.py.\n",
        "# Negative Example: A Research Figure with Missing Information\n\nDeliver only a screenshot without units or an explanation of uncertainty. Delete unexpected points to make the curves overlap, and keep no data-processing or plotting code.\n",
    ),
    "note": (
        "# Positive Example: Explaining BCS from a Band-Structure Background\n\nBackground source: the Demo rates Bloch's Theorem as proficient and BCS Theory as aware. Material source: the original example article A Route into Superconductivity for Band-Structure Researchers, section 'From pairing to mean field'. Start from normal-state bands to explain ξₖ as energy relative to the chemical potential, then define Δ as the pairing gap parameter. The formula Eₖ=√(ξₖ²+|Δ|²) applies only to the uniform, single-band, s-wave mean-field model used here. No new calculations have been performed; solving for the pairing parameter self-consistently remains a learning question.\n",
        "# Negative Example: Skipping Definitions and Evidence\n\nObviously every system obeys the same scaling.\nAdding a Δ to any band proves that it is a superconductor.\nThere is no need to explain the symbols.\nThere are no sources, but we can claim the result is verified.\n",
    ),
    "numerics": (
        "# Positive Example: A Verifiable Calculation Plan\n\nUse Julia, ITensors.jl, and ITensorMPS.jl, saving project dependencies and random seeds. First check energies, boundary conditions, and normalization at a size accessible to exact diagonalization (ED), then scan bond dimension, truncation threshold, and time step separately.\n\nThe Demo's fictional submission entry point is scripts/submit_job.sh. First confirm that it exists and read the parameter documentation. If it supports a dry run, check the command and resources for configs/small.toml. This material describes a workflow only; no jobs have been submitted. Save results under a unique run ID and validate checkpoints together with their parameters.\n",
        "# Negative Example: An Irreproducible Calculation\n\nRun the largest system immediately, arbitrarily replace the algorithm framework, and omit random seeds. Assume the server has submit_job.sh and claim that a job was submitted. Overwrite every result in results/latest, then load an old checkpoint after a failure without checking its parameters.\n",
    ),
}


def base(model, identifier):
    return {"schema": model.expected_schema, "entity_type": model.expected_entity_type,
            "id": identifier, "status": "active", "revision": 1,
            "created_at": STAMP, "updated_at": STAMP}


def record(root, model, collection, identifier, body="", **values):
    item = model.model_validate({**base(model, identifier), **values})
    path = root / "records" / collection / f"{identifier}.md"
    path.write_text(dump_markdown_record(
        item.model_dump(mode="json", by_alias=True, exclude_none=True), body,
    ), encoding="utf-8")


def source(root, identifier, content, kind="article"):
    content = content.strip() + "\n"
    digest = hashlib.sha256(content.encode()).hexdigest()
    folder = root / "sources" / identifier
    folder.mkdir()
    (folder / "original.md").write_text(content, encoding="utf-8")
    manifest = SourceManifest.model_validate({
        "schema": "ai-persona.source-manifest/v2", "id": identifier,
        "source_type": kind, "imported_at": STAMP,
        "origin": {"provider": "ai-persona-synthetic-demo", "identifier": identifier,
                   "retrieved_at": STAMP},
        "canonical_file": "original.md", "content_hash": digest,
        "files": [{"path": "original.md", "role": "original",
                   "media_type": "text/markdown", "sha256": digest}],
    })
    (folder / "manifest.yaml").write_text(yaml.safe_dump(
        manifest.model_dump(mode="json", by_alias=True, exclude_none=True),
        allow_unicode=True, sort_keys=False,
    ), encoding="utf-8")
    return digest


def build(root):
    for directory in REQUIRED_DIRECTORIES:
        (root / directory).mkdir(parents=True, exist_ok=True)
    (root / "demo.json").write_text(json.dumps(DEMO_METADATA, indent=2) + "\n")
    (root / "config/persona.toml").write_text(
        f'[persona]\nid = "demo-{DEMO_VERSION}"\nrevision = 1\n'
        f'created_at = "{STAMP}"\ninclude_human_notes_in_snapshot = true\n',
    )
    (root / "revisions/changes.jsonl").write_text("")
    for slug, title in [("physics", "Physics")]:
        record(root, Tag, "tags", f"tag_{slug}", namespace="domain", slug=slug,
               label=title, aliases=[])
    for slug, title, role, domain, level, interest, summary, parent in KNOWLEDGE:
        record(root, KnowledgeNode, "knowledge-nodes", f"kn_demo_{slug}",
               body="Fictional profile: a doctoral researcher studying two-dimensional magnetic and topological materials, familiar with crystals and DFT, and learning topology and superconductivity. Knowledge and interest levels are assigned solely for demonstration.\n",
               title=title, semantic_role=role, knowledge_level=level,
               interest_level=interest, summary=summary, tags=[f"tag_{domain}"],
               scope_note="Change this level in the Demo to explore how it affects the starting point of a note.")
        if parent:
            record(root, Relation, "relations", f"rel_demo_tree_{slug}",
                   source_id=f"kn_demo_{parent}", target_id=f"kn_demo_{slug}",
                   relation_type="broader_than")
    for src, dst in [("bloch", "reciprocal"), ("wannier", "bloch"), ("chern", "berry"),
                     ("spin_wave", "heisenberg"), ("bdg", "bcs")]:
        record(root, Relation, "relations", f"rel_demo_requires_{src}_{dst}",
               source_id=f"kn_demo_{src}", target_id=f"kn_demo_{dst}", relation_type="requires")
    for src, dst in [("wannier", "tight_binding"), ("spin_orbit", "anisotropy"),
                     ("berry", "quantum_hall"), ("tight_binding", "topology"),
                     ("ginzburg_landau", "vortex")]:
        record(root, Relation, "relations", f"rel_demo_applied_{src}_{dst}",
               source_id=f"kn_demo_{src}", target_id=f"kn_demo_{dst}", relation_type="applied_in")
    for i, (slug, title, covered, summary, content) in enumerate(ARTICLES):
        sid, mid, eid = f"src_demo_article_{slug}", f"mat_demo_{slug}", f"ev_demo_{slug}"
        digest = source(root, sid, content)
        record(root, Material, "materials", mid, body="An original example article for exploring reading and review in the public Demo.\n",
               material_type="article", title=title,
               bibliography={"authors": ["AI Persona Demo"], "language": "en",
                             "published_at": STAMP[:10], "venue": "Original Demo Article"},
               user_relationships=["read" if i < 4 else "skimmed"],
               knowledge_level="familiar" if i in {0, 3} else "aware",
               preference_level="favorite" if i == 3 else "liked", summary=summary,
               preference_reasons=[{"aspect": "practicality", "note": "Useful for practicing research reading and organizing tasks."}],
               tags=["tag_physics"],
               source_ref=sid, evidence_refs=[eid])
        record(root, Evidence, "evidence", eid,
               body="This record locates an original Demo article only; it does not establish a real user's knowledge level.\n",
               source_id=sid, source_hash=f"sha256:{digest}",
               locator={"file": "original.md", "line_start": 1,
                        "line_end": len(content.strip().splitlines())},
               supports=[mid], evidence_kind="authored_material", extraction_method="demo-seed")
        for j, topic in enumerate(covered):
            record(root, Relation, "relations", f"rel_demo_article_{slug}_{topic}",
                   source_id=mid, target_id=f"kn_demo_{topic}", relation_type="covers",
                   knowledge_role="topic" if j == 0 else "background",
                   salience="primary" if j < 2 else "secondary",
                   statement="This article uses the topic to organize reading or practical questions.")
    for slug, key, name, description, intents, excludes, artifact_types, rules in CONTEXTS:
        cid = f"pctx_demo_{slug}"
        record(root, PreferenceContext, "preference-contexts", cid, key=key, name=name,
               description=description, activation={"intents": intents, "excludes": excludes,
                                                     "artifact_types": artifact_types})
        for n, (behavior, instruction, condition) in enumerate(rules, 1):
            record(root, Preference, "preferences", f"pref_demo_{slug}_{n:02}",
                   scope="contexts", context_refs=[cid], behavior=behavior,
                   instruction=instruction, condition=condition, rationale="A fictional Demo user preference.")
        for polarity, content in zip(["positive", "negative"], SAMPLES[slug], strict=True):
            sid = f"src_demo_sample_{slug}_{polarity}"
            digest = source(root, sid, content, "other")
            record(root, PreferenceExample, "preference-examples", f"pex_demo_{slug}_{polarity}",
                   context_refs=[cid], example_type=polarity,
                   title=f"{name} · {'Positive Example' if polarity == 'positive' else 'Negative Example'}",
                   condition=description, reasons=["Use this context’s rules to check whether the information, steps, and records are complete."],
                   source_ref=sid, content_hash=f"sha256:{digest}")
    with tempfile.TemporaryDirectory(prefix="demo-compile-") as state:
        PersonaCompiler(root, Path(state)).build()


def main():
    # Refuse any existing data directory without the explicit Demo marker.
    if TARGET.exists() and not (TARGET / "demo.json").is_file():
        raise SystemExit("Refusing to replace a directory without a Demo marker")
    with tempfile.TemporaryDirectory(prefix="demo-seed-", dir=TARGET.parent) as staging:
        seed = Path(staging) / "persona-data"
        build(seed)
        if TARGET.exists():
            shutil.rmtree(TARGET)
        shutil.move(str(seed), TARGET)
    print(f"Built 30 knowledge nodes, 5 articles, 3 contexts, 14 rules and 6 samples: {TARGET}")


if __name__ == "__main__":
    main()
