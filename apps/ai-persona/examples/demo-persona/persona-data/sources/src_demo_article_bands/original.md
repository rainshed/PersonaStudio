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
