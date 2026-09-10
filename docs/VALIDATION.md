# Delivery validation / 交付验证

Validated locally on 2026-09-10 using macOS ARM64, Python 3.12.13 and Node.js 24.13.0. GitHub Actions is configured for macOS/Linux; a hosted run is not claimed before the repository is uploaded.

2026-09-10 在 macOS ARM64、Python 3.12.13、Node.js 24.13.0 上完成本地验证。GitHub Actions 已配置 macOS/Linux 检查，尚未上传的仓库没有托管 CI 运行结果。

Initial delivery baseline, before the startup fix below / 以下为启动修复前的首次交付基线：

| Check / 检查 | Result / 结果 |
| --- | --- |
| Python application and integration tests | **726 passed**, no skipped tests |
| Browser-side JavaScript tests | **74 passed** |
| Model runtime tests | **51 passed**, including Pi adapter calls against local test servers |
| Ruff | Passed |
| Chromium user flows | **37 page visits**, no unexpected browser errors |
| Wheel built from the source distribution | Passed |
| Wheel installation in a fresh environment outside the checkout | Passed; bundled Demo validates and the workspace/setup routes load |
| Package contents | 407 wheel files and 589 source-distribution files; required templates, static assets, Demo, runtime lock and licenses present |
| Existing source inventory | All 205 original source/assets files retained, including all 25 original top-level page templates |
| Existing route declarations | All 113 unique original HTTP method/path pairs retained |
| Public repository inventory | Personal workspaces, account stores, development environments, logs and test output excluded |

The browser checks cover knowledge graph layout/search/detail, course creation and immediate save, materials and original sources, inbox views, evaluations, settings, English/Chinese switching, 390px layouts and first-run setup. Missing optional model dependencies are exercised as expected first-use states; no real model account is used.

Backup regression tests verify drafts, prompt state and external learning history; byte-identical immutable SQLite source files; pending source bundles followed by successful review after restore; corrupted archives and unsafe paths; existing-destination protection; and failure rollback. Restored connections and automatic features require explicit re-enabling.

The legacy regression PDF was replaced with an original, reproducibly generated fictional fixture while preserving stable IDs and graph relationships. The original application and personal workspaces were not modified during this delivery.

## Startup follow-up / 启动问题修复

On 2026-09-10, a real first-run failure exposed a default-port conflict with an existing Studio and remote gateway. `setup` and `start` now automatically select an available port when no explicit port was requested. The parent reserves the listener and passes it to the child, avoiding a gap in which another process could take the port. Explicit ports remain fixed; healthy instances of the same workspace are reused.

2026-09-10 的实际首次使用发现默认端口与已有 Studio、远程网关冲突。现已支持自动选择空闲端口，并在启动子进程期间持续保留该端口。向导也提供具体错误详情；默认工作区保存失败时会保留已启动 Studio 的访问入口。

- **80 focused Python tests passed**: 13 launcher, 25 onboarding, and 42 workspace, CLI and web-access tests. This includes a real first-create POST with an occupied preferred port, successful child startup, workspace identity verification and preservation of the original listener.
- Chromium checks passed again: **37 page visits**, no unexpected errors.
- A rebuilt wheel passed installation outside the checkout, including actual startup with an occupied preferred port and reuse of the resulting instance. The source archive includes the updated regression tests.
- Ruff and onboarding JavaScript syntax checks passed. The full initial suite above was not repeated for this focused fix.

## Guided AI setup / AI 首次使用流程

The 2026-09-10 follow-up adds in-page runtime diagnosis/installation and guides users through accounts, credentials, model tests and saved defaults. API-key methods and the existing supported account-login methods remain available; see [the support matrix](MODEL_CONNECTIONS.md).

- **747 Python tests passed**, no skips; **74 browser-side JavaScript tests** and **51 model-runtime tests** passed.
- The existing **37-page Chromium smoke** passed without unexpected errors.
- The new `npm run test:first-use` scenario passed with empty runtime/account/workspace directories: missing-Node guidance (simulated environment response), actual pinned npm installation from the page, reload recovery, the real adapter's OAuth method selector, pending-login recovery/cancellation, API-key storage, local-provider SDK calls, rejection/retry and persisted default-model verification. Desktop and 390px Chinese layouts were inspected. Test services are stopped and temporary accounts are removed by the harness.
- A wheel built from the source distribution passed a fresh installation outside the repository. The installed application handled a busy default port, installed model components through its HTTP endpoint and loaded an empty account list. Archives contain **409 wheel files** and **593 source-distribution files**.
- The current local Studio was restarted with the updated code and runtime; its model-environment and model-configuration endpoints return success.

**Live provider login was not performed by the automation.** The real-adapter browser test deliberately stops before the provider's account login. The API-key request tests use a local fixture endpoint, not a real billed account. Actual subscription eligibility, API-key permission and provider access require the account-owned check documented in [model connections](MODEL_CONNECTIONS.md). No all-platform real-account certification is claimed.

2026-09-10 已验证可由页面完成环境安装并进入账号认证流程；真实提供方的账号登录、订阅权限和具体模型额度仍由用户本人完成最终验收。自动测试没有使用个人账号或付费调用。

## Error visibility and analysis timeout follow-up / 错误提示与分析超时修复

Validated locally on 2026-09-10: **747 Python**, **74 browser-side JavaScript** and **53 model-runtime** tests passed (**874 total**), with no skipped tests. The offline browser regression verifies visible inline errors, offscreen navigation, stable repeated polling, expandable sections, clipped scrolling panels, dialogs, and failed HTMX requests at desktop and 390px widths. The existing browser workflow and first-use model setup also passed without unexpected browser errors.

A simulated material call completes successfully after four minutes, past the former three-minute cutoff. Separate checks verify cancellation, bounded timeouts, no automatic replay after partial content, and accurate checkpoint recovery messages. No personal model request was replayed during validation; actual provider completion time is not guaranteed by a larger local budget.

The latest clean wheel installation passed, with 411 wheel files and 596 source-distribution files, including the shared error feedback assets.

前台维护与材料分析单次上限现为 7 分钟，总请求预算 8 分钟。回归验证覆盖超时、取消、完整分段保存与恢复，以及长页面、弹窗、折叠区和内部滚动区的错误定位。未使用个人模型账号重跑分析，真实模型能否在新上限内完成仍取决于提供方和任务。

## Subscription stream diagnostics follow-up / 订阅流式响应复核

After the timeout investigation, the runtime suite passes **55 tests**. New local fixtures exercise the real Pi Codex adapter over SSE and WebSocket, leaving the upstream connection open after a terminal response. Both return successfully; event telemetry contains only event types, times, character counts and numeric output limits. A reasoning-only stream is explicitly distinguished from a text response. The pinned adapter omits the Codex subscription output cap, so the application-requested `maxTokens` must not be presented as an enforced limit for that transport.

The updated release archives also pass clean installation (411 wheel files, 597 source-distribution files). The Python and general frontend baseline remains the preceding 747/74 run; no Python behavior or general frontend behavior changed in this follow-up.

新增测试使用本地假服务和虚构凭据，不登录真实账号。真实任务的运行元数据只用于判断延迟发生在哪一层，不能据此推断所有模型或网络环境的速度。

## Reproduce / 复现

From the repository root / 在仓库根目录运行：

```sh
python3 scripts/check.py
python3 scripts/verify-release.py
npm ci
npx playwright install chromium
npm run test:errors
npm run test:browser
npm run test:first-use
```

These checks use isolated temporary workspaces and local mock providers. Browser screenshots use only fictional Demo data. AI-provider account authorization, paid model quality and actual remote-host deployments still depend on each user's configuration; the automated tests do not claim to exercise those accounts or machines.
