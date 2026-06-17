# Agent Map

This document is the outline-level map and code-style routing table for `packages/erpc`. It tracks stable IPC package responsibilities and the sample routes used for coding alignment.

## 1. Module Overview

- **Description**: Type-safe IPC bridge package.
- **Architecture**: tRPC-style contracts over Electron IPC for main and renderer processes.

## 2. Outline Tree

```json
{
	"entry": ["package.json", "rslib.config.ts", "tsconfig.json"],
	"shared_contracts": {
		"src/constants.ts": "IPC channel and protocol constants shared across processes.",
		"src/types.ts": "Cross-process public type contracts."
	},
	"process_adapters": {
		"src/main": "Main-process handler creation, message handling, and preload exposure utilities.",
		"src/renderer": "Renderer-side IPC link and client helpers."
	}
}
```

## 3. Code Style Routing

This routing table is scoped to outline-level folder matching. Match by `path_scope` with longest-prefix wins.

```json
{
	"package root": {
		"path_scope": "packages/erpc",
		"sample_pool": ["packages/erpc/package.json", "packages/erpc/rslib.config.ts"]
	},
	"src root contracts": {
		"path_scope": "packages/erpc/src",
		"sample_pool": ["packages/erpc/src/types.ts", "packages/erpc/src/constants.ts"]
	},
	"src/main": {
		"path_scope": "packages/erpc/src/main",
		"sample_pool": ["packages/erpc/src/main/createIPCHandler.ts", "packages/erpc/src/main/exposeERPC.ts"]
	},
	"src/renderer": {
		"path_scope": "packages/erpc/src/renderer",
		"sample_pool": ["packages/erpc/src/renderer/index.ts", "packages/erpc/src/renderer/ipcLink.ts"]
	}
}
```

## 4. Notes

- Generated or transient directories such as `dist`, `node_modules`, `.turbo`, and protected `__*` folders are intentionally omitted.
- Keep the map at package and process-domain granularity. Do not expand routine leaf files beyond entry contracts and public coordination nodes.
