# Contributing

English and Chinese issues and pull requests are welcome. Start with a bug report or proposal when changing a user workflow, data format, or public integration.

## Development setup

From the repository root:

```sh
./scripts/ai-persona start --demo
```

Use the fictional Demo or a temporary workspace. Keep real materials, conversations, credentials, and private deployment information outside the checkout.

Run the combined checks from the repository root. The check runner creates isolated application state, installs the optional model runtime in its test environment, and runs the Python, browser-independent JavaScript, and model-runtime checks:

```sh
python3 scripts/check.py
```

For focused development checks, run from `apps/ai-persona`:

```sh
PYTHONPATH=src uv run --locked --extra dev ruff check .
PYTHONPATH=src uv run --locked --extra dev pytest
node --test tests/test_*.mjs
```

The root launcher uses a regular installation so it also works in folders where editable installs are unreliable. For source development, the explicit `PYTHONPATH=src` above selects the current source. Node.js is needed for the JavaScript tests. Tests that require the optional model adapter may skip when its dependencies are unavailable. State skipped checks in the pull request; do not substitute a live account or paid model call for an offline test without a specific reason.

The root `npm run test:browser` command exercises browser flows after installing the root development dependencies and the configured Playwright browser. `python3 scripts/verify-release.py` verifies source/wheel packaging and a clean installed Demo. These checks require their documented local tooling; a passing local run does not claim that hosted CI or a public release exists.

## Publishing a release

Use `apps/ai-persona/pyproject.toml` as the application version source. Update it and `CHANGELOG.md`, then refresh `apps/ai-persona/uv.lock`. Before tagging, build and exercise the same assets that GitHub will publish:

```sh
uv lock --project apps/ai-persona
python3 scripts/verify-release.py
python3 scripts/build-release.py --dist-dir dist/release --expected-tag v0.1.0
python3 scripts/test-installer.py --dist-dir dist/release
```

Commit those source changes, create the matching `vMAJOR.MINOR.PATCH` tag, and push the tag. The release workflow repeats all checks, creates a draft GitHub Release, uploads the versioned archive, rendered installer, manifest and checksums, then publishes it. Do not create or move a public version tag until its source commit is final.

## Changes we can review

- Explain the problem, the behavior after the change, and the relevant validation.
- Preserve existing `ai-persona` commands and the distinction between human edits and AI proposals.
- Add focused regression coverage for behavior or data-format changes. A documentation correction usually does not need a new test.
- Keep English and Chinese user-facing text consistent. Update the appropriate usage guide when commands or setup change.
- Commit dependency declarations and their lockfile together. The Python lockfile belongs to `apps/ai-persona`; the Node runtime has its own lockfile.
- Keep third-party license notices alongside vendored assets. Avoid unrelated generated files or broad formatting changes.

For data migration changes, demonstrate behavior on an isolated copy, explain backup and rollback, and avoid overwriting an existing destination. Never use a contributor's personal workspace as a test fixture.

## Documentation

- Keep permanent documentation in the repository root and `docs/`; application design history belongs in Git, issues, and pull requests.
- Use one language per file. English files use `NAME.md`; their Chinese peers use `NAME.zh-CN.md`.
- Keep paired documents structurally aligned and update both when a command, workflow, or public contract changes.
- Do not add dated delivery logs or completed implementation plans as permanent documentation. Put reproducible behavior in tests and release changes in `CHANGELOG.md`.
