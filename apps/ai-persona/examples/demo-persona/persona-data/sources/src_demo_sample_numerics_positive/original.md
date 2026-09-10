# Positive Example: A Verifiable Calculation Plan

Use Julia, ITensors.jl, and ITensorMPS.jl, saving project dependencies and random seeds. First check energies, boundary conditions, and normalization at a size accessible to exact diagonalization (ED), then scan bond dimension, truncation threshold, and time step separately.

The Demo's fictional submission entry point is scripts/submit_job.sh. First confirm that it exists and read the parameter documentation. If it supports a dry run, check the command and resources for configs/small.toml. This material describes a workflow only; no jobs have been submitted. Save results under a unique run ID and validate checkpoints together with their parameters.
