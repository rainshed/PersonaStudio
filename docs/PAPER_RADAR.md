# Paper Radar: local use and review

[简体中文](PAPER_RADAR.zh-CN.md) · [PersonaStudio](../README.md)

Paper Radar is the second application in this repository. This is a local review version; a combined release has not been built or published. The existing installer and published releases still install AI Persona.

## Setup

The current supported validation target is macOS, with Node.js 22.19 or newer and uv. From the repository root:

```sh
npm run setup:radar
npm start
```

Setup installs locked dependencies and builds the web app. It does not configure a running DSH profile or call a model. Paper Radar runs in the background, opens the browser, and reuses a verified existing process for the same data directory. If the default port 4317 is occupied, it chooses an available port; an explicitly requested port stays fixed.

```sh
npm run radar -- status
npm run radar -- stop
npm run radar -- doctor
npm run radar -- logs
npm run persona -- start
```

## First use

1. Connect AI Persona: discover the configured workspace, test the connection and save it. Manual program selection is under advanced settings.
2. Create a subscription: choose arXiv subjects, Persona tags, output language and a call budget.
3. Connect Codex or DSH from the workspace to generate recommendations and detailed reports.

Normal startup has no sample-experience step. Existing research workspaces open directly. Both applications offer a link to open the other. Radar continues to use the scoped, read-only Persona query interface.

## Existing features

Daily papers, single-paper analysis, subscriptions, followed authors, paper/report reading, sources and evidence, feedback, benchmarks, evaluation experiments, prompt editing, host settings, notifications, scheduling, cancellation and recovery are retained. Historical data remains compatible. Previously retired discussions remain retired, with their saved data preserved.

## Data and isolated review

The default remains `~/.local/share/paper-radar/`, with research data in `data/`. Moving the source does not move personal data. Two application versions must not write to the same research data directory at once.

For a clean first-use review:

```sh
npm run radar -- start --home "$HOME/.local/share/personastudio/paper-radar-review"
npm run radar -- status --home "$HOME/.local/share/personastudio/paper-radar-review"
npm run radar -- stop --home "$HOME/.local/share/personastudio/paper-radar-review"
```

`--home` isolates data, host configuration and runtime state. `--data-dir` selects only the research data directory.

Settings → Data and preferences offers backups, downloads, restore into a new directory, opening recovered copies and diagnostic export. Backups contain consistent snapshots of the research and prompt databases, cached papers, the Persona connection and onboarding state. They exclude host credentials, the Persona workspace itself and browser preferences. Restore validates file hashes and database integrity, preserves current data and pauses automatic checks. Opening a recovered copy from the UI uses isolated host settings.

Downloaded backups can also be restored locally:

```sh
npm run radar -- restore "/path/to/backup.tar.gz" --data-dir "/path/to/new-data"
npm run radar -- start --data-dir "/path/to/new-data"
```

Diagnostics contain versions, platform, connection status and record counts. They exclude accounts, private paths, papers, prompts and logs. Data management and application launch endpoints require local access; existing remote research access remains available.

## Validation

```sh
npm run check:radar
```

This runs type/lint checks, application and plugin tests, actual read-only AI Persona integration, a production build and an isolated application lifecycle/backup/restore check. Persona integration is mandatory through this entry point. No real model calls are made.

The optional static demonstration remains available to developers through the explicit `VITE_PAPER_RADAR_MODE=demo` build setting. Ordinary startup never falls back to it on connection failure.

Before distributing, manually review the first-use flow, both analysis hosts, all research pages, task cancellation/recovery, and backup restoration. Packaging, version selection and GitHub publication are deferred until that review.
