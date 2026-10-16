# Package Browser execution host

This optional generic host keeps a package's sandboxed execution document alive independently of its presentation windows. The package retains its existing domain Runtime and state machine. The host owns documents, opaque owner leases, trusted source selection, and MessagePort handoff. It contains no Simulator, MCU, firmware, compiler, or device logic.

This implementation is isolated on `i3w-unified-browser-host`, based on `090c6d1f661eb75619eef338c239f9794164e7e5`. Relevant host/owner/port files in the original working tree matched that commit, so no uncommitted source was migrated. The original Blockly working tree was not modified. No dependency installation or shared build is required for the direct host tests.

## Declaration and trust

An installed package can opt in alongside its existing UI declaration:

```json
{
  "ailySubapp": {
    "runtime": {
      "browserExecution": {
        "protocol": "aily-browser-execution-v1",
        "root": "browser",
        "entry": "execution.html",
        "sha256": "<actual SHA-256 of execution.html>"
      }
    },
    "ui": { "surfaces": { "full": { "entry": "browser/full.html" } } }
  }
}
```

`headless:true` means a package with no UI and is rejected for this declaration. The hidden execution document is a separate concept. The declaration above describes a contract; no existing Simulator manifest is changed or claimed to implement it by this host branch.

Main process calls the existing package manager's `prepareLaunch` and reads the selected package's actual manifest. The selected package name/version/path must match the already registered Runtime. The Runtime version remains pinned while it has consumers; a selected-version mismatch fails closed rather than borrowing a different package. The entry must be a bounded local HTML file below the declared public subdirectory, with matching SHA-256. All declared surfaces must remain under that root. The entry hash protects the entry HTML only, not transitive JS/WASM assets. Package distribution trust continues to depend on the existing install/release selection mechanism; a development/local fixture is a locally trusted package, not proof of a signed remote distribution.

The host starts an owned ephemeral loopback static server; renderer IPC cannot supply a URL, directory, manifest, hash, capability secret or network endpoint. Responses require the exact owned Host header and apply COOP `same-origin`, COEP `require-corp`, CORP `same-origin`, no CORS, `nosniff`, and a restrictive CSP. Serving checks real containment, regular files, no symlink components or dotfiles, and a finite extension list including JS/WASM/data assets. Execution windows use a new nonpersistent partition, `sandbox:true`, `contextIsolation:true`, `webSecurity:true`, all Node integration disabled, no window opens, no permission grants, and network requests restricted to that owned origin or its blob URLs. No secret is put in a URL.

Remote UI and arbitrary localhost URLs are unsupported. This implementation does not relax `surface.entry`, expose Node or account credentials to a remote page, or establish a remote origin/version trust policy. That would require its own reviewed package bootstrap and explicit source/version/instance checks.

## Owner and port lifecycle

The IPC composition uses an acknowledged `SubappOwnerSupervisor.createOwnerGuard`. A caller repeating an owner id cannot acquire this capability. The guard pins the current renderer generation, registered Runtime stream, and owner session. The host reuses `child-tool-session-leases` for reference counting, with one independent execution domain per registered Runtime. Browser code receives no process-file lease path, PID, AppData, compiler, or Node API.

The public JSON result is `{ endpoint: { kind: 'browser-message-port', runtimeId: '<opaque UUID>' }, version }`. A new execution gets a new UUID; the id is invalid after its final owner leaves. The actual MessagePort is transferred separately once to its authorized renderer. Node stream ids and package paths stay internal.

`window.electronAPI.childToolSession.browserExecution` is the low-frequency main-renderer composition entry. Its payload uses the existing `toolId`, `generation`, `ownerSessionId`, plus one action:

- `acquire`: selects/verifies the package and acquires that execution owner without opening UI.
- `connect`: accepts the returned opaque `runtimeId`, then hands its port to that same owner renderer.
- `openView`: accepts `runtimeId` and a declared surface name, opens an isolated package View, and directly joins its connection to the existing execution domain.
- `closeView`: accepts `runtimeId` and that owner's `connectionId`; waits for package detach acknowledgement before destroying the View.
- `release`: revokes only that execution owner. Other owners retain the same execution domain.

Main renderer preload provides one-way `window.postMessage` delivery of `subapp-browser-execution-port`; it does not expose an execution API inside package documents. Package code must verify `event.source === window`, exact `event.origin`, protocol, pinned package version and role before accepting the transferred port. The preload itself exposes no Node, invoke, filesystem, Agent or arbitrary IPC API.

The package execution entry installs its port listener before asynchronous initialization. Main transfers a private host-control port with role `host`, protocol, execution UUID and package version. The package replies `{ type: 'ready', protocol }`. Main sends bounded lifecycle frames `{ protocol, id, type, ... }`; replies are `{ id, ok: true, value }` or `{ id, ok: false }`:

- `attach` includes `connectionId`, `purpose` (`agent` or `view`), an optional declared surface, and a transferred direct peer port. Store the trusted connection context in a closure; do not accept a peer-supplied owner identity as authority.
- `detach` includes that `connectionId`. Revoke the connection and await all its subscriptions/resources before acknowledgement. A View close must not stop a domain session retained by another owner.
- `shutdown` is sent only after final ownership ends or the registered Runtime shuts down. Await the existing Runtime's cleanup and worker termination before acknowledgement.

Domain RPC, snapshots, cursors, sessions and event schemas remain package responsibilities. Event MessagePorts may be transferred onward directly to the real Worker. Main process must not relay raw GPIO edges or other high-frequency events. Closing a View automatically requests detach through the private lifecycle port. A navigation/crash invalidates that connection; it does not release unrelated Chat owners. Owner release fences held attachments synchronously before awaiting cleanup, so a late attach ACK cannot hand a port to a departing owner. Failed detach remains retryable and cannot become a clean acknowledgement. Shutdown timeout forces physical document/window destruction and reports `acknowledged:false`; this is distinct from a graceful Runtime resource-zero receipt.

Budgets are 32 execution domains, 256 owners/domain, 32 direct connections/domain, 16 declared surfaces, 1 MiB entry HTML, 16 KiB lifecycle replies, and bounded 10-second lifecycle requests by default (constructor range 10 ms to 30 seconds). The selected Runtime shutdown/app quit drains its Browser execution before the associated Node process.

## Validation and remaining integration

Run the dependency-light host/owner/window tests from this isolated tree with existing dependencies available read-only, for example on this machine:

```powershell
$env:NODE_PATH='D:\codes\aily-blockly\node_modules'
node --test electron/subapp-browser-execution-host.test.js electron/child-tool-session-leases.test.js electron/subapp-owner-supervisor.test.js electron/child-tool-runtime-exit.test.js electron/child-tool-session-process.test.js electron/app-shutdown.test.js electron/renderer-lifecycle.test.js electron/tests/subapp-agent-lifecycle-manifest.test.js
```

The real Electron/AVR technical harness and complete reports live in the Simulator-owned ignored directory `.runtime/unified-core-u2/generic-host-integration-20261016-a01`. It loads these actual host modules, the frozen BrowserSessionRuntime/AVR CPU, and a frozen normal Uno Pro Builder artifact. It verifies owner A first without View, owner B sharing the same domain, late View/snapshot/direct Worker event port, View destroy and cursor reattach without MCU replacement, A release preserving B, then actual resource/Worker/window/listener/process cleanup after B releases. Its owners are controlled technical guards, its observer is a bounded technical View, and its composition is development; it does not claim installed Agent, subscription authorization, complete package FullUI or U4 acceptance.

The current frozen Browser Runtime fixture only supports cancellation through the event peer port, so that proof deliberately uses orderly View cancellation and real Worker cancel ACK before closing the View. A production execution entry must also own a trusted connection-scoped cancellation capability for abrupt View crash/navigation cleanup. A generic host detach ACK is insufficient evidence that a package actually removed such a subscription. The Simulator branch is adding that package-specific contract; no MCU model belongs in this host.

The standard Agent Bridge and a package's Node `node-ipc-v1` adapter do not yet consume this new host API in this first commit. The main/preload composition and technical fixture are implemented; an end-to-end Agent-first product path is not yet implemented. The next integration is a generic, owner-authorized, low-frequency JSON request/reply/cancel broker over the already registered process stream, with direct ports for View event traffic. Node process IPC cannot transfer Chromium MessagePorts by putting them in JSON. Opening FullUI to obtain an execution owner is not an acceptable fallback.

Broader Angular/npm regression attempts encountered absent isolated `rxjs` resolution and a Windows `npm.cmd` fixture invocation problem. They are recorded as environment failures, not passes. No dependency installation or workaround in the original working tree was performed.
