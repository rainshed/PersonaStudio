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

## Changes we can review

- Explain the problem, the behavior after the change, and the relevant validation.
- Preserve the [page and feature contract](docs/FEATURE_PARITY.md), existing `ai-persona` commands, and the distinction between human edits and AI proposals.
- Add focused regression coverage for behavior or data-format changes. A documentation correction usually does not need a new test.
- Keep English and Chinese user-facing text consistent. Update the appropriate usage guide when commands or setup change.
- Commit dependency declarations and their lockfile together. The Python lockfile belongs to `apps/ai-persona`; the Node runtime has its own lockfile.
- Keep third-party license notices alongside vendored assets. Avoid unrelated generated files or broad formatting changes.

For data migration changes, demonstrate behavior on an isolated copy, explain backup and rollback, and avoid overwriting an existing destination. Never use a contributor's personal workspace as a test fixture.

## 中文说明

欢迎使用中文提交问题和 PR。请说明具体问题、修改后的行为和验证结果；涉及页面、命令或数据格式时，同步更新兼容矩阵及使用文档。开发与测试使用虚构 Demo 或临时工作区，不提交私人材料、对话、凭据和部署记录。涉及安全问题时，请先查看 [SECURITY.md](SECURITY.md)。
