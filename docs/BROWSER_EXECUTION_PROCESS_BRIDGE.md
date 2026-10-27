# Registered Node process to Browser execution connection

This is the generic low-frequency transport used by an Agent-first package. Domain tool RPC remains the package's existing Node RPC. Blockly does not know Simulator operations or send arbitrary Browser operations to View. The independent package execution document remains the sole domain Runtime owner, and a View joins it through a separate direct MessagePort.

The package declares both `runtime.browserExecution` (see `BROWSER_EXECUTION_HOST.md`) and `runtime.processMessagePort: { transport: 'node-ipc-v1', maxMessageBytes: ... }`. The installed-state projection exposes only `{protocol:'aily-browser-execution-v1'}` for Browser capability detection. The main process still reads and verifies the original selected package declaration, entry hash and version before starting any document.

The standard `SubappAgentBridgeService.request` first establishes the registered Node Runtime and calls `SubappOwnerGuard.track`. For an opted-in package, it then invokes the main-owned `bindProcess` action before sending the Node domain RPC. Missing host support fails the invocation; it never opens FullUI as a fallback. Unchanged packages do not call this API. Lifecycle cleanup never launches a new execution document.

Node receives this main-issued context in the existing domain RPC envelope:

```json
{
  "context": {
    "sessionId": "<existing opaque Agent owner lease>",
    "browserExecution": {
      "endpoint": {"kind":"browser-message-port","runtimeId":"<execution UUID>"},
      "connectionId":"<main-issued connection UUID>"
    }
  }
}
```

`connectionId` is an internal owner/stream-scoped capability. Do not return it to a remote UI or expose it as an Agent tool result. Node cannot create a binding by reporting an owner id or a URL. Only the acknowledged main-process owner guard can issue it, pinned to that registered process stream and execution instance. One owner reuses one process connection; different owners retain separate connections to the same execution document. The connection is invalid after revocation, process replacement, document failure or final ownership release.

The broker's main-only MessagePort is created through `SubappBrowserExecutionHost.connectRuntime`. It is never put into JSON, transferred to Node, or exposed through preload. Main consumes only the following reserved Node process message types. All other existing process messages retain their current routing. The actual process stream comes from the registered IPC source, never a payload field.

Actual owner lifetime is separate from connection lifetime. Main randomly creates a private `ownerHandle` for each actual owner reference. Only the trusted host `attach` control frame contains it; Node context, public endpoints and View preload metadata do not. The execution entry captures `{ownerHandle, connectionId, purpose}` from that private frame. A connection detach cancels/joins its requests and subscriptions but must not release the owner's retained MCU session. The same owner may reconnect after a request timeout with the same owner handle. Actual `host.release` fences new connections/requests synchronously, detaches/joins the owner's connections, then sends private `{type:'owner-release',id,ownerHandle}`. The entry releases that owner's holds through its existing application owner-reference path and acknowledges only after cleanup. Main removes its real owner reference only after this ACK; failure retains the retiring owner handle/reference and cleanup callback for retry. Final ownership then sends `shutdown` and waits for the Runtime's real cleanup. No Simulator ownership state belongs in Blockly.

The existing supervisor sends Node `ownerRelease` only after main-process cleanups complete. This later Node callback therefore cleans Node-side work idempotently; it cannot depend on the already revoked Browser connection or report unacknowledged Browser cleanup as success. View detach never sends `owner-release`. An entry must accept repeated owner release idempotently because a cleanup ACK can be lost.

Node request, via `process.send`:

```json
{"type":"aily-subapp-browser.request","version":1,"runtimeId":"<UUID>","connectionId":"<UUID>","requestId":"<unique id>","payload":{"packageDefinedOperation":"..."},"timeoutMs":10000}
```

The same frame is delivered over the authorized execution connection. The package's trusted execution entry validates the frame against the connection context captured from the private host `attach` closure. It validates a finite package domain schema, rejects peer-supplied owner/source/connection overrides, serializes domain writes through the existing Runtime, and produces:

```json
{"type":"aily-subapp-browser.result","version":1,"runtimeId":"<same UUID>","connectionId":"<same UUID>","requestId":"<same id>","ok":true,"result":{}}
```

Failures use `ok:false`, `errorCode` and `error`. Frames may contain only finite plain JSON accepted by the existing `normalizeProcessMessage`, including its depth limit. The execution entry must not return raw events, handles, transferable ports, URLs, Node capabilities or account credentials over this process channel. Main never replays a mutation after a lost reply.

Cancellation, via the same registered Node IPC stream:

```json
{"type":"aily-subapp-browser.cancel","version":1,"runtimeId":"<same UUID>","connectionId":"<same UUID>","requestId":"<same id>"}
```

Sending cancel is not an operation-completed acknowledgement. The broker retains the pending record and its budget until the execution connection returns a terminal result or its private host detach is acknowledged. The execution entry must cancel and join its connection-owned requests before host detach ACK; cancelling a request does not inherently stop a retained MCU session. A timed-out request sends cancel. If no terminal result arrives within the three-second cancellation grace, the connection is fenced and detach is attempted. An unacknowledged detach reports `BROWSER_EXECUTION_CANCEL_UNCONFIRMED` once while retaining the cleanup capability and pending budget for retry/final physical teardown. It does not silently mark the request stopped. Duplicate request ids fence the connection instead of replaying work.

Limits are the smaller of the registered Node IPC limit and 1 MiB per frame, 16 requests per connection, 64 globally, 16 MiB aggregate pending input bytes, 128 process connections, and a 100–30000 ms operation deadline. Requests exceeding capacity return `BROWSER_EXECUTION_BUSY`; malformed input returns `BROWSER_EXECUTION_INVALID_REQUEST`; a stale/cross-stream connection returns `BROWSER_EXECUTION_NOT_AUTHORIZED`. Cancellation and timeout return their corresponding `BROWSER_EXECUTION_CANCELLED` / `BROWSER_EXECUTION_TIMEOUT` only after a terminal execution result. Connection shutdown returns `BROWSER_EXECUTION_CLOSED`. Error strings are bounded, and oversized/non-JSON data is not sent through process IPC.

Large firmware, ELF, graph or asset input must use the package's own bounded chunk protocol, such as 64 KiB blocks, with digest/length/sequence checks and explicit finalization in the existing application input path. A single 10 MiB base64 ELF does not fit this transport. Artifact and device schemas remain inside the package. High-throughput View events, including GPIO samples, stay on direct Worker-to-View ports with their existing ACK/backpressure protocol; they never traverse this broker.

Product integration status must distinguish the generic host/broker and standard Bridge consumption from an installed package's actual Node adapter, trusted execution entry, FullUI and authorized Chat session. Direct tests and the isolated real Electron/Node/AVR technical proof do not establish U4 fresh generation or production subscription authorization.
