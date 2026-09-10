# Fixed regression fixture

This is the previous small Demo, retained for tests that rely on its IDs, graph
shape and empty preference catalog. Tests copy it into temporary directories.
It is not the public Demo and is not included in the installed wheel.

The public Demo lives in `examples/demo-persona` and has dedicated distribution
and isolation tests in `tests/test_workspace.py`.

All personal-state values in this fixture are fictional. Its one-page PDF,
"Synthetic Transport Study", is original test material created for PersonaStudio
and distributed under the project's MIT license. It contains no real authors,
published paper, or actual reading history. Stable IDs are retained solely for
regression compatibility.

Regenerate the PDF, source hashes, material metadata, matching historical entry,
and derived projections from `apps/ai-persona` with:

```sh
PYTHONPATH=src uv run --locked --extra dev --with reportlab==5.0.1 python scripts/build_legacy_pdf_fixture.py
```

The generator uses fixed metadata, standard fonts, and a pinned PDF library. It
addresses only this fixture and builds temporary indexes outside the fixture.
