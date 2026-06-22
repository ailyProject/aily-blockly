# Review Prep Audit

## Purpose

This document is the pre-review evidence ledger for the ongoing refactor.

It is not the final refactor report. Its job is to:

- record what has already been verified in the current worktree
- record what still needs explicit proof before final completion
- reduce repeated re-discovery before `review`, legacy walkthrough, and the final report

## Current Strong Evidence

### Monorepo Build Graph

Verified in current worktree:

- `pnpm run build:workflows`
- `pnpm run build`

Meaning:

- root `turbo` graph is working for `shared`, `erpc`, `core`, `desktop`, `ui`
- workflow generation scripts are executable and current

### Per-Package Build Evidence

Recently verified:

- `pnpm --filter shared build`
- `pnpm --filter erpc build`
- `pnpm --filter core build`
- `pnpm --filter desktop build`
- `pnpm --filter ui build`
- `pnpm --filter ui build` after the latest `lib-manager` type/component split
- `pnpm --filter core build` after the latest `libraryManage.registry.*` split and `cloud/types.*` split
- `pnpm --filter core build` and `pnpm --filter ui build` after the latest `cloud/request.*` split
- `pnpm --filter core build` after the latest `connection/remote.*` split
- `pnpm --filter core build` after the latest `ffs/runtime/filesystem.*` split
- `pnpm --filter core build` after the latest `ffs/runtime/bridge.*` split
- `pnpm --filter core build` after the latest `document/pageLifecycle.*` split
- `pnpm --filter core build` after the latest `project/lock.acquire.*` split
- `pnpm --filter core build` after the latest `project/readSource.*` split
- `pnpm --filter core build` after the latest `build/projectBuild.types.*` split
- `pnpm --filter core build` after the latest `connection/graph.types.*` split
- `pnpm --filter core build` after the latest `connection/remote.normalize.*` split
- `pnpm --filter core build` after the latest `libraryManage.registry.search.*` split
- `pnpm --filter core build` after the latest `hardware/search.types.*` split
- `pnpm --filter core build` after the latest `libraryManage.types.*` split
- `pnpm --filter core build` after the latest `connection/catalog.types.*` split
- `pnpm --filter core build` after the latest `api/rstream.*` split
- `pnpm --filter core build` after the latest `hardware/fuzzy/validate.*` split
- `pnpm --filter core build` after the latest `hardware/upload/runtime.*` split
- `pnpm --filter core build` after the latest `hardware/upload/command.*` split
- `pnpm --filter core build` after the latest `hardware/probe/runtime.*` split
- `pnpm --filter core build` after the latest `hardware/firmware/remote.*` split
- `pnpm --filter core build` after the latest `abs/types.*` split
- `pnpm --filter core build` after the latest `serial/types.*` split
- `pnpm --filter core build` and `pnpm --filter ui build` after consolidating recent `types.*.ts` files back into single `types.ts`
- `pnpm --filter core build` after the latest `agent/runtime/sessionControls.*` split
- `pnpm --filter core build` after the latest `connection/remote.sync.*` split
- `pnpm --filter core build` after the latest `ffs/runtime/clients/spiffs.*` split
- `pnpm --filter core build` after the latest `ffs/runtime/clients/fatfs.*` split
- `pnpm --filter core build` after the latest `connection/pinmap.catalog.*` split
- `pnpm --filter core build` after the latest `build/projectBuild.run.*` split
- `pnpm --filter core build` after the latest `agent/session/turns.summary.*` split
- `pnpm --filter core build` after the latest `ffs/paths.*` split
- `pnpm --filter core build` after the latest `document/pageLifecycle.document.*` split
- `pnpm --filter core build` after the latest `project/config/mutations.*` split
- `pnpm --filter core build` after the latest `hardware/indexData.*` split
- `pnpm --filter core build` after the latest `tool/discovery.*` split
- `pnpm --filter core build` after converting `hardware/probe/runtime*` to directory-based naming
- `pnpm --filter core build` after the latest `project/readAbi.*` split
- `pnpm --filter core build` after the latest `ffs/imageWorkflow.mutate.*` split
- `pnpm --filter core build` after the latest `ffs/runtime/nodeSerialPort.*` split
- `pnpm --filter core build` after the latest `metadata/libraryRecovery.*` split
- `pnpm --filter core build` after renaming current agent runtime/session dotted files to non-dotted names
- `pnpm --filter core build` after renaming current api/document/project dotted files to non-dotted names
- `pnpm --filter core build` after renaming current agent session dotted files to non-dotted names
- `pnpm --filter core build` after converting `project/config/mutations*` to directory-based naming
- `pnpm --filter core build` after converting `hardware/firmware/remote*` to directory-based naming
- `pnpm --filter core build` after converting `api/rstream*` to directory-based naming
- `pnpm --filter core build` after converting `agent/runtime/runCore*` to directory-based naming
- `pnpm --filter core build` after converting `project/archive*` to directory-based naming
- `pnpm --filter core build` after converting `tool/process*` to directory-based naming
- `pnpm --filter core build` after converting `project/libraryManage/registry*` to directory-based naming
- `pnpm --filter core build` after converting `project/readSource*` to directory-based naming
- `pnpm --filter core build` after converting `hardware/query*` to directory-based naming
- `pnpm --filter core build` after converting `hardware/indexData*` to directory-based naming
- `pnpm --filter core build` after converting `project/regions*` to directory-based naming
- `pnpm --filter core build` after converting `hardware/esptool/logic*` to directory-based naming
- `pnpm --filter core build` after converting `project/store/layout*` to directory-based naming
- `pnpm --filter core build` after renaming current agent runtime/session dotted files to non-dotted names
- `pnpm --filter core build` after renaming document `pageLifecycle.*` / `workspace.*` files to non-dotted names
- `pnpm --filter core build` after the latest `agent/runtime/AgentRuntime.*` split
- `pnpm --filter core build` after the latest `project/packageArchive.*` split
- `pnpm --filter core build` after consolidating `ffs/mount.types.ts` and `ffs/summary.types.ts` back into `ffs/types.ts`
- `pnpm --filter ui build` after adding the Blockly missing-library blocking state
- `pnpm --filter ui build` and `pnpm --filter desktop build` after fixing:
  - Blockly missing-library restore self-broadcast/reload contention
  - `desktop.host.focusProcess` Windows command binding
- `pnpm --filter desktop build` after fixing the Linux `xdotool` focus fallback to use `search -> windowactivate`
- `pnpm --filter ui build` after restoring the terminal page to an `xterm`-based interactive shell surface
- `pnpm run build` after the terminal `xterm` migration and dependency/lockfile update
- `pnpm --filter ui build` after fixing the terminal `xterm` initialization/view-sync race
- `pnpm --filter ui build` after splitting `lib-manager` and `cloud-space` large templates into page-local section components

### Release / Packaging Evidence

Verified in current worktree:

- `pnpm --filter desktop run pack:linux`
- `pnpm run build:mac`
- `pnpm run build:win`
- `pnpm run build:linux`
- `node scripts/trim_desktop_release.mjs --platform mac --no-install`

Observed artifacts:

- `release/desktop-mac/app/package.json`
- `release/desktop-win/app/package.json`
- `release/desktop-linux/app/package.json`

Meaning:

- root build scripts route through `turbo -> desktop#pack:* -> trim_desktop_release.mjs`
- trimmed release manifests now preserve packaging metadata such as `productName`, `build.appId`, `protocols`, and `fileAssociations`
- current backend dotted-file residue is down to `ffs/runtime/wasm/littlefs/littlefs.d.ts`, which is a Wasm declaration artifact rather than active business implementation

## Domain Status Snapshot

### Core

- `agent`: functionally migrated enough to proceed to final audit
- `build`: migrated enough to proceed to final audit
- `hardware.upload`: serial/debugger/BLE paths exist; richer UX still open
- `project.lifecycle`: migrated enough to proceed to final audit
- `project.library-management`: usable and significantly improved; realtime streaming still open
- `cloud`: usable and significantly improved; `remove_cover` backend semantics still need proof
- `connection`: migrated enough to proceed to final audit
- `ffs`: migrated enough to proceed to final audit
- `serial`: migrated enough to proceed to final audit
- `rpc/router`: major dead-surface cleanup already done; should be rechecked once before final completion, not continuously

### UI

- `blockly-editor`: good enough for final audit, but not full watcher parity
- `code-editor`: good enough for final audit, but not full watcher parity
- `terminal`: good enough for final audit; xterm surface is back, remaining questions are now mostly BLE/detail polish rather than basic emulator absence
- `lib-manager`: good enough for final audit; current evidence suggests missing streaming is not a legacy blocker
- `cloud-space`: good enough for final audit; `remove_cover` and server-backed history are currently treated as additive/non-blocking unless live walkthrough disproves that
- `project-open`: structurally in good shape for final audit

### Desktop

- `core bootstrap / host / terminal / BLE chooser`: good enough for final audit
- `file association`: metadata path exists, full end-to-end packager/installer proof still open

## Remaining Items That Still Need Proof

### Before Running `review`

- confirm no obviously wrong dead-surface cleanup removed something intentionally retained for future consumption
- confirm no current build command is failing after the latest changes

### During `review`

- prioritize:
  - behavioral regressions
  - hidden state bugs
  - stale event/listener cleanup issues
  - conflicts between polling and mutation events
  - packaging/release script correctness

Recently found and fixed during review-prep:

- `blockly-editor` no longer dispatches self-originated library-mutation events during in-page missing-library restore, avoiding redundant concurrent reloads
- `desktop.host.focusProcess` Windows branch now inlines the validated pid into the PowerShell command instead of relying on fragile trailing script arguments
- `desktop.host.focusProcess` Linux `xdotool` fallback now performs an actual `search` followed by `windowactivate`, rather than incorrectly treating `windowactivate` as a search pattern
- terminal `xterm` mount now drives a reactive readiness signal so viewport sync and buffered output replay are not skipped when the shell session appears before the DOM host
- `cloud-space` overview-panel extraction no longer triggers eager reloads on every auth-token keystroke; token updates are again kept in-memory until an explicit refresh/scope action

### During Legacy Walkthrough

Must explicitly compare against:

- `legacy_deepwiki/3.1-project-lifecycle.md`
- `legacy_deepwiki/3.2-library-management.md`
- `legacy_deepwiki/3.3-library-editor.md`
- `legacy_deepwiki/5.2-hardware-upload.md`
- `legacy_deepwiki/5.3-terminal-integration.md`
- old repo `/Users/xiewendao/Documents/aily/aily-blockly/`

Key questions:

- does the live backend accept `remove_cover=true` cleanly, even though this is now treated as an additive enhancement rather than a legacy blocker?
- is current file association coverage only metadata-level plus trimmed app manifest proof, or actually proven at installer/runtime registration level?
- are remaining BLE UX gaps acceptable as “partial but aligned”, or did legacy ship an expectation we still miss?
- are there any remaining library flows that depended on Verdaccio-side package/version indexes beyond what is now implemented?
- is `desktop.host.focusProcess` sufficiently reliable in packaged/runtime conditions, especially on Linux where it currently depends on external tools (`wmctrl` / `xdotool`), or should it remain classified as best-effort rather than blocker-grade parity?

## Final Audit Gate

Only start the formal `review` pass once the following are true in the current worktree:

- `pnpm --filter core build` passes
- `pnpm --filter ui build` passes
- `.draft/legacy-gap-audit.md` has no remaining item that is both:
  - user-visible
  - proven legacy-required
  - still missing locally
- `.draft/refactor_goal_todo_list.md` walkthrough matrix has every item classified as one of:
  - `verified`
  - `still verify`
  - `optional / additive`

At that point, remaining work should be review/audit/report driven rather than migration-structure driven.

## Non-Blocking Conclusions

These are current evidence-based conclusions and should not be re-opened casually without new contradictory evidence:

- `cloud-space remove_cover`
  - local implementation is complete
  - old repo/docs do not prove it was a legacy contract
  - live backend behavior still deserves a sanity check, but this is not currently a blocker
- `cloud-space server-backed sync history`
  - old repo/docs do not show a historical implementation
  - current local persisted history is therefore acceptable unless new evidence appears
- `lib-manager realtime streaming`
  - old repo progress semantics were notice-driven
  - current `progressEvents + Live Action` polling satisfies the same user-facing requirement
- `terminal BLE deep UX parity`
  - old repo evidence is strongest at service/protocol level, not terminal-specific detail UI
  - current remaining differences look enhancement-level unless walkthrough evidence proves otherwise

### Before Final Report

- run a fresh large-file scan and compare against current hotspots
- decide whether remaining hotspots are acceptable:
  - type definition files
  - action-layer files
  - vendor exclusions

Latest source-level hotspot snapshot after excluding `dist`, `node_modules`, and `vendor`:

- large-but-intentional domain type files remain:
  - `packages/core/src/project/types.ts`
  - `packages/core/src/connection/types.ts`
  - `packages/core/src/hardware/upload/types.ts`
  - `packages/core/src/hardware/types.ts`
- the current largest non-type/non-generated UI hotspot is:
  - `packages/ui/src/pages/lib-manager/types.ts`
- `packages/ui/src/pages/terminal/component.ts` has already been reduced again by moving `xterm` lifecycle logic into `pages/terminal/runtime/xterm.ts`
- `packages/ui/src/pages/lib-manager/component.html` has already been reduced by splitting declared/missing/catalog/registry/activity rendering into page-local section components
- `packages/ui/src/pages/cloud-space/component.html` has already been reduced by moving controls/status/binding cards into `components/overview-panel.*`
- `packages/ui/src/pages/cloud-space/component.ts` has already been reduced further by moving refresh/session-binding orchestration into `component.runtime.ts`
- `packages/ui/src/pages/lib-manager/component.ts` has already been reduced further by moving local signals/derived views into `component.state.ts`
- `packages/ui/src/pages/lib-manager/component.interactions.ts` is now only a barrel; install/refresh/registry/scope flows live in dedicated page-local interaction modules
- `packages/ui/src/pages/project-open` has also been migrated away from page-local `component.actions.*` helper naming:
  - helper logic now lives under `pages/project-open/utils/*`
- `packages/ui/src/pages/lib-manager` has already been migrated away from page-local `component.*.ts` helper naming:
  - helper logic now lives under `pages/lib-manager/utils/*`
  - this is the new preferred cleanup pattern for other page hotspots under the user's latest naming rule
- `packages/ui/src/pages/cloud-space` has also been migrated to the same page-local `utils/*` pattern:
  - former `component.*` and `page-actions.*` helpers now live under `pages/cloud-space/utils/*`
  - page-only action/context types were folded back into the root `types.ts`
- `packages/ui/src/pages/terminal` has now started the same page-local `utils/*` migration:
  - `component.state.ts` -> `utils/state.ts`
  - `component.types.ts` -> `utils/types.ts`
  - `component.ble.ts` -> `utils/ble.ts`
  - `sizing.runtime.ts` -> `utils/sizing.ts`
  - former `build.*` and `session.*` helper filenames are now expressed as directories such as `actions/build/*`, `actions/session/*`, `runtime/build/*`
- `packages/ui/src/pages/code-editor` has now also completed the same page-local `utils/*` migration:
  - former `component.signals.ts` / `page-actions.runtime.ts` / `session.runtime.ts` / `build-actions.runtime.ts` / `ble-actions.runtime.ts` now live under `utils/*`
  - former `ble.runtime.*` helper files now live under `utils/ble/*`
  - `component.types.ts` was folded back into the root `types.ts`
  - the page no longer appears in the remaining non-Angular multi-dot helper naming debt list
- `packages/ui/src/pages/serial-monitor` has now also completed the same page-local `utils/*` migration:
  - `component.signals.ts` -> `utils/signals.ts`
  - `component.view-actions.ts` -> `utils/view.ts`
  - `upload.runtime.ts` -> `utils/upload.ts`
  - `component.types.ts` was folded back into the root `types.ts`
- `packages/ui/src/pages/project-new` has now also completed the same page-local `utils/*` migration:
  - `component.signals.ts` -> `utils/signals.ts`
  - `component.state.ts` -> `utils/state.ts`
  - `component.types.ts` was folded back into the root `types.ts`
- `packages/ui/src/pages/home` has now also completed the same page-local `utils/*` migration:
  - `component.actions.ts` -> `utils/actions.ts`
- `packages/ui/src/pages/graph-editor` has now also completed the same page-local naming cleanup that does not require a full `utils/` tree:
  - `component.types.ts` was folded back into the root `types.ts`
  - `actions/edit.drafts.ts` / `edit.persistence.ts` / `edit.sync.ts` are now expressed as `actions/edit/{drafts,persistence,sync}.ts`
- `packages/ui/src/pages/blockly-editor` has now also completed the same page-local `utils/*` migration:
  - `component.signals.ts` -> `utils/signals.ts`
  - `component.state.ts` -> `utils/state.ts`
  - `page-actions.runtime.ts` -> `utils/page-actions.ts`
  - `workspace-editor.runtime.ts` -> `utils/workspace-editor.ts`
  - `component.runtime/*` now lives under `utils/runtime/*`
- `packages/ui/src/pages/ffs-manager` has now also completed the same page-local `utils/*` migration:
  - former `component.actions.*` now lives under `utils/actions/*`
  - former `component.handlers.*` now lives under `utils/handlers/*`
  - `component.edit.actions.ts` -> `utils/edit.ts`
  - `component.viewmodel.ts` -> `utils/view-model.ts`
  - `explorer.runtime.ts` / `preview.runtime.ts` -> `utils/{explorer,preview}.ts`
  - `explorer.types.ts` / `component.handlers.types.ts` were folded back into the root `types.ts`

Outstanding frontend page-helper naming debt after this change:

- none in `packages/ui/src/pages` for non-Angular helper `.ts` files under the current rule set

Repository-wide frontend helper naming debt after the latest batch:

- none in `packages/ui/src` for non-Angular helper `.ts` files under the current rule set
- remaining dotted files in `ui/src` are now limited to:
  - Angular component convention files such as `*.component.ts`
  - explicit test file `app-spec.ts`
- verified again after the latest repo-wide sweep and `pnpm --filter ui build`

## Current Recommendation

The refactor appears to be entering the stage where:

- continuing to randomly add features is lower value
- review-prep and final audit work now has higher leverage

Recommended next sequence:

1. keep only small, clear, low-risk fixes if they close an already-known gap
2. begin formal `review`
3. fix review findings
4. perform legacy walkthrough
5. run large-file diagnosis
6. write final root refactor report
