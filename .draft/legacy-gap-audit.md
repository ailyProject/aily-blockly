# Legacy Gap Audit

## Scope

- Current target: compare the experimental monorepo against `legacy_deepwiki/` and the old repo at `/Users/xiewendao/Documents/aily/aily-blockly/`.
- Focus areas:
  - `project lifecycle`
  - `library management`
  - `terminal / build / upload orchestration`
  - `cloud-space`

## Current Alignment

### Project Lifecycle

- Aligned:
  - `project.abi` read/write is in `core.project`.
  - `project.abi.temp` is written alongside `project.abi`.
  - read fallback to `.temp` exists when primary is missing or malformed.
  - lifecycle summary exists in `core.project.getProjectLifecycleStatus`.
  - UI now exposes lifecycle summary in `settings`.
  - desktop-driven open-project flow exists:
    - `open-file`
    - initial `argv`
    - `second-instance` `argv`
  - manual `Project Open` page exists and can resolve file-or-directory input to project root.
  - current project session persists `projectPath/editorRoute` in local storage.
  - current project can be explicitly closed from `settings`.
  - open-session lock now persists correctly across the active session.

- Still missing or partial:
  - no full watcher equivalent for `package.json` / board dependency changes.
  - current workaround is stronger than the initial migration baseline:
    - manual `Reload Project` in `blockly-editor`
    - lifecycle polling + `Reload Project State` prompt in `code-editor`
    - lifecycle signature now includes dependency signature fields, so same-count dependency swaps are also detected
    - lightweight project mutation events for library/cloud-sync driven refreshes
    - `code-editor` now also auto-queues external library/cloud changes that happen during build/upload and refreshes plans after the current action finishes
  - conflict handling is still only partially aligned:
    - current `project-open` flow has lifecycle preview + explicit `Cancel / Focus Existing Window / Force Open`
    - the normal `Open Project` action no longer bypasses a detected open-session conflict
    - old `ProjectService` had an explicit `cancel / focus other process` prompt path
    - current `Focus Existing Window` now routes through `desktop.host.focusProcess`, keeping the window/process activation concern in `desktop`
    - the legacy code still carried a `force` return type, but the actual force-open button was commented out
    - remaining uncertainty is now narrower:
      - macOS / Windows have an explicit best-effort focus path
      - Linux now tries `wmctrl` first and falls back to `xdotool`
      - real packaged runtime behavior still deserves a manual walkthrough before calling this fully proven
  - desktop file-association support is now partial:
    - release template `release/desktop-app/package.json` carries `.abi` file association metadata
    - generated trimmed release app manifests under `release/desktop-{mac,win,linux}/app/package.json` also preserve the same `.abi` association metadata
    - current repo still does not have installer/runtime evidence proving end-to-end OS registration after install

### Library Management

- Aligned:
  - `lib-manager` page exists in `ui`.
  - declared Blockly libraries, ready libraries, and missing libraries are derived from `core.project.getBlocklyLibraryStatus`.
  - restore/remove actions exist through `core.project.installBlocklyLibrary` and `removeBlocklyLibrary`.
  - explicit local-library import entry now exists and reuses the desktop directory picker plus a `core.project.inspectBlocklyLibrarySource` validation step.
  - compatible catalog suggestions exist from `workspace.libraryIndex`.
  - compatibility status for declared libraries is shown in the UI.
  - install flow now has a minimal compatibility review step before proceeding with a known incompatible catalog library.
  - local `file:`-style restore is supported for missing libraries and declared libraries.
  - `blockly-editor` now has an in-editor missing-library recovery panel with `Restore` / `Restore All`.
  - `blockly-editor` now also blocks entry into the editable workspace when Blockly libraries are missing:
    - restore actions are surfaced before editing continues
    - users can leave the project instead of saving an incomplete workspace
  - last action stdout/stderr/exitCode is visible in the page.
  - install/remove results now include parsed package-manager progress events for a more readable staged summary.
  - installed-only / missing / catalog scoped filtering now exists with a shared fuzzy-search input.
  - a dedicated `Core Libraries` quick filter now exists, matching a common legacy shortcut flow.
  - source visibility now exists for declared / missing / catalog cards (`registry` vs `local file`).
  - successful library install/remove now emits a project-library mutation event that the mounted Blockly editor can react to.
  - on-demand registry version listing now exists for library cards.
  - remote registry search now exists in `lib-manager` using the current resolved npm registry and prefers Verdaccio-style package version indexes when available.
  - polling-based live action status now exists during install/remove.
  - legacy install-progress behavior was notice-driven:
    - old `NpmService` parsed `Download progress` / `Extract progress`
    - progress was surfaced through `NoticeService`, not through the terminal surface
    - current `progressEvents + Live Action` polling already covers the same functional feedback path
  - legacy registry/version depth was shallower than the current implementation:
    - old version lookup was `npm view <package> versions --json`
    - old search relied on local library lists plus fuzzy search
    - current `registry search + version list + catalog` already exceeds that baseline

- Still missing or partial:
  - Blockly hot-load is now partial:
    - mounted Blockly editor can auto-refresh when there is no dirty workspace draft
    - when the draft is dirty, ancillary project state now refreshes without overwriting the current workspace JSON
    - there is still no full watcher-equivalent end-to-end reload model
  - code-editor hot-refresh is now stronger:
    - non-busy external library/cloud mutations refresh plans in place without reinitializing the source draft
    - busy build/upload windows queue a pending refresh and auto-consume it afterwards

### Terminal / Build / Upload

- Aligned:
  - desktop PTY exists.
  - terminal line splitting handles `CRLF`, standalone `\r`, and `Ctrl+C` better than the initial version.
  - `executeOnce` now captures exit codes.
  - build now has:
    - `prepareProjectBuild`
    - live preprocess / compile in the active PTY session
    - fallback to structured `core.build.runProjectBuild` diagnostics on failure.
  - serial upload now has:
    - `prepareUploadExecution`
    - live upload in the active PTY session
    - fallback to structured `core.hardware.runUpload` diagnostics on failure.
  - debugger upload now uses the same terminal target abstraction:
    - target list can include `probe-rs` devices
    - live upload and fallback upload both consume the same target payload
    - `core` now auto-resolves debugger `pnum` from `package.json.projectConfig.pnum`
  - terminal now also has a minimal live BLE host path:
    - BLE device selection runs through `desktop.ble.*`
    - BLE upload planning uses `core.hardware.prepareBleUpload`
    - BLE transport executes in renderer via the existing Web Bluetooth OTA runtime
    - this intentionally replaces the old repo's loose `window.electron.ble` / global bridge style with typed `desktop.ble.*`, while preserving the end-user flow
    - preferred BLE device ID is now persisted locally and reused on the next chooser flow
    - already-authorized BLE devices can now be restored into `code-editor` and `terminal` on reload when the platform exposes them
    - terminal now subscribes to chooser-discovered BLE device lists and merges them into the upload target list
    - terminal BLE path now also emits unified upload summary / recovery hint text
  - terminal page now surfaces a last-upload summary card with retry / reconnect actions
  - selected upload target is now persisted locally across serial / debugger / BLE
  - BLE list refresh now auto-prefers the last used device and falls back to the first available device
  - terminal page now has minimal clipboard ergonomics again:
    - copy current output
    - paste clipboard into input
    - direct `Enter` send
    - `Shift+Enter` newline
    - `Ctrl/Cmd + L` clear
    - output auto-scroll to the newest content
  - terminal page now also has a lightweight command history recall path via `ArrowUp / ArrowDown`.
  - terminal UI shows command previews, upload progress summaries, and fallback logs.
  - terminal now again uses an `xterm`-based interactive shell surface instead of a plain `pre + textarea` fallback shell UI.
  - legacy evidence shows BLE OTA parity was primarily service/protocol level:
    - old repo documents `UploaderBleService` states, packetization, ACK/CRC, and device authorization
    - old terminal docs focus on PTY/xterm behavior, not a separate BLE-specific terminal chooser/history/detail surface
    - current repo already preserves the runtime boundary needed for BLE OTA:
      - `core` protocol/preparation
      - `desktop` chooser bridge
      - `ui` Web Bluetooth transport

- Still missing or partial:
  - no install-progress stream for library/npm flows through the same terminal surface.
  - BLE upload UX is still lighter than serial/debugger, but this now looks like polish rather than a proven legacy blocker:
    - no fuller chooser/history/detail parity
  - BLE runtime boundary is intentionally different from legacy internals:
    - `core` owns packet/protocol/preparation logic
    - `desktop` owns Electron chooser/permission/device-list bridge
    - `ui` owns `navigator.bluetooth` transport because it must execute in the browser runtime
  - this means the remaining BLE bridge cannot be fully moved into `core` without losing the Electron `BrowserWindow/session/WebContents` hooks it depends on

### Cloud Space

- Aligned:
  - public/template/mine scopes exist.
  - import flow exists.
  - sync current project exists.
  - metadata editor exists.
  - page / pageSize pagination controls now exist in the page layer and are wired to the same core list queries.
  - sync current project now exposes a structured last-sync summary in the page.
  - a minimal in-page recent sync history now exists and is persisted locally.
  - current local project can now resolve its cloud binding and highlight the matching cloud item in the list.
  - current local project binding now also has a dedicated summary card above the cloud list.
  - current project binding now reacts to project session changes without requiring a full page refresh.
  - metadata editor now includes a read-only project details section alongside editable fields.
  - cover removal intent is now carried through the editor draft and cloud update payload.
  - `core.cloud.updateProject` request layer now explicitly sends `remove_cover=true` when requested.
  - publish / unpublish / template / delete actions exist.
  - cover image processing is handled in UI and forwarded through `core`.
  - legacy evidence does not show a historical `remove_cover` backend contract:
    - old `CloudService.updateProject(...)` only sent `nickname / description / doc_url / tags / image`
    - no old frontend call site or DeepWiki page describes explicit cover deletion semantics
  - legacy evidence also does not show any server-backed sync history feature:
    - old `cloud-space` only synced and refreshed the current list
    - no local or remote history UI/service exists in the archived implementation

- Still missing or partial:
  - cover removal is now treated as an additive enhancement, not a legacy blocker:
    - local implementation is complete
    - only live backend behavior remains to be sanity-checked later
  - no richer cross-device or server-backed sync history beyond the local recent summary list:
    - this is currently classified as optional unless later walkthrough evidence proves otherwise

## Highest-Value Remaining Gaps

1. Review-driven bug sweep and final legacy checklist.

## Recommended Next Moves

1. Use `.draft/refactor_goal_todo_list.md` as the final walkthrough matrix and convert every remaining uncertainty into either:
   - proven aligned
   - explicitly still missing
   - explicitly not required
2. Only add more UI work if it closes one of the remaining functional uncertainties above.
3. Once those uncertainties are reduced, begin the pre-review audit pass:
   - enumerate remaining non-trivial mismatches
   - run `review`
   - fix findings
   - prepare final report.
