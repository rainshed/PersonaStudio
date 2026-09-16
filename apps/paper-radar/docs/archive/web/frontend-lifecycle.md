> 历史设计或验证记录。当前结构与运行方式以 [项目说明](../../../README.md) 为准；独立模型功能已移除。

# Frontend boundaries and request lifecycle

The page entry point only determines whether the current endpoint provides the real application or the standalone demonstration. `ResearchShell` and `ResearchTopbar` provide navigation, mobile layout, language controls, and the live notification entry point for both data sources. `DemoHome` and `DemoPaperReader` contain simulated data behavior; `LiveRadarApp` composes real subscription and report views. Saved real reports continue to share `PaperWorkspace` across daily reports and single-paper analysis.

`LiveSubscriptionEditor` owns its isolated form draft and revision-aware save. `model-editors.tsx` owns account/model drafts and validation. The model settings page retains task routing and unsaved routing drafts; visiting another page does not unmount previously visited settings or analysis pages.

## Queries

`useDailyFeed`, `useAnalysisHistory`, `usePersonaTags`, and `DailyDetails` own retrieval and presentation identity. They use `useRequestPolling`, also shared by discussion updates, login status and task notifications. The underlying `startRequestPolling` is independent of React and tested with a deterministic timer.

- A request identity change aborts the preceding lifecycle. Responses check the lifecycle signal before publishing state.
- At most one request executes per lifecycle. A wake from tab visibility, focus or network reconnection never starts an overlapping request.
- The next timer starts after completion. Transport failures use bounded retry backoff; errors remain visible. Stop/unmount aborts the active request and removes wake listeners and timers.
- Active work refreshes every 2–2.5 seconds; settled report/history views refresh every 15 seconds. Notification retrieval uses 4 seconds. These are UI refresh cadences, not task execution limits.
- Report details publish a paper and its associated report together. Rendered identity checks prevent a preceding paper's report from appearing during selection changes. Evidence requests are separately abortable when another citation is selected or the panel closes.
- A saved reference to a missing task displays the explicit error without a misleading loading state. Falling back from a missing subscription clears its obsolete paper selection.

`useIsMobile` reads the browser media query with `useSyncExternalStore`; server and initial hydration use the same desktop-shaped snapshot.

## Evidence presentation

`evidence-presentation.ts` only formats saved metadata. `EvidenceSource` distinguishes abstracts, body paragraphs, excerpts, captions, table text, equation text, references and Persona records. It displays section, file, pages, lines, character range and record revision when those fields exist. Missing location fields are left absent. Caption/table/equation evidence includes a text-extraction limitation; report coverage explicitly separates available text blocks from actual cited evidence and does not claim visual interpretation.

## Verification

Run the normal `typecheck`, `lint`, `test` and `build` scripts. Focused frontend regressions cover polling overlap/cancellation/retry, evidence ranges and text-only scope, URL restoration, interface language, report identity, backend response handling and single-analysis behavior.

For browser acceptance without credentials or model providers:

```sh
npm run build
PAPER_RADAR_PREVIEW_PORT=14318 PAPER_RADAR_PREVIEW_MODEL_DELAY_MS=2500 node --experimental-strip-types tests/helpers/ui-preview.mjs
```

The helper seeds an isolated temporary database and only calls deterministic mock models. The optional delay applies after seeding, allowing cancellation to be exercised. Use a dedicated port because 4318 may already serve Prompt Workbench.

The 2026-09-13 manual acceptance pass covered desktop and 390px mobile reading/evidence layout, close/Escape, browser back preserving a selected report section, unsaved analysis drafts across navigation, cancelling subscription edits, single-analysis cancellation and later historical selection after reload, and the feedback → frozen evaluation dataset → budget preview → mock A/B → cancel → history → resume flow. This validates application behavior, not scientific quality or real provider compatibility.

## Lint compatibility

Correctness, React hooks and React compiler checks remain enabled. Generated `components/ui` primitives keep valid ARIA wrapper roles through a scoped preference-rule exception. The primitive `Label` receives its control association from callers; the input-group addon has pointer-only focus convenience for its already keyboard-focusable input. These exceptions do not apply to business components. Actual carousel cleanup, unsafe chart key conversion, and missing application control associations were fixed directly.
