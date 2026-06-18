# Desktop declaration fix

Goal: fix desktop declaration-generation errors after rslib config schema update.

Current errors:

- TS7016 for imports from erpc/main in desktop source files.
- TS7031 implicit any on createContext({ event }).

Planned steps:

1. Inspect desktop source imports and erpc output/types layout.
2. Inspect package exports and tsconfig paths/resolution assumptions.
3. Patch desktop and/or erpc typing issues with minimal changes.
4. Rebuild erpc and desktop to verify.

Update:

- Added desktop tsconfig path mapping: erpc/main -> ../erpc/src/main/index.ts to avoid dependency on prebuilt erpc dist declarations.
- New issue after source path mapping: desktop strict declaration build surfaces erpc/main/createIPCHandler nullability error on frame.routingId.
- Patched erpc/src/main/createIPCHandler.ts: use frame?.routingId because Electron navigation frame can be null.
- Renamed packages/erpc/rslib.config.ts to rslib.config.mts to remove Node MODULE_TYPELESS_PACKAGE_JSON warning without changing package runtime semantics.
