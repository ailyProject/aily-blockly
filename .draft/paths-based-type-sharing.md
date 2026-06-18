## Goal

Replace cross-package declaration-file hacks with source-based TypeScript `paths` mappings so sibling packages share types through source entrypoints instead of `dist/*.d.ts` shims.

## Findings

- `packages/ui/tsconfig.json` maps `shared`, `core/*`, `desktop`, and `erpc/renderer` to built declaration files under sibling `dist/` directories.
- `packages/desktop/tsconfig.json` maps `shared`, `core/*`, and `erpc/main` to sibling `dist/*.d.ts`.
- `packages/ui/src/types/core-modules.d.ts` manually declares `core/rpc` and `core/hardware` modules from `../../../core/dist/...`.
- `packages/ui/src/desktop-service/client.ts` and `types.ts` import desktop router types from `../../../desktop/dist/src/rpc/types`.
- This mirrors the exact anti-pattern the user called out: type sharing depends on built output instead of source `paths`.

## Reference

- `polywise/packages/app/tsconfig.json` uses `baseUrl: "../"` and `paths` to sibling source trees.
- `polywise/packages/polywise/tsconfig.json` also points `paths` at sibling source trees rather than `dist/*.d.ts`.

## Plan

1. Update package tsconfigs to point cross-package aliases at sibling source entrypoints.
2. Remove manual declaration shims that exist only to patch missing source resolution.
3. Replace remaining direct `dist` type imports with path-based source imports.
4. Build affected packages to verify the new source-sharing setup compiles cleanly.

## Progress

- 2026-06-18: Compared current repo against the polywise reference and identified `dist`-based type sharing and declaration shims as the main problems.
- 2026-06-18: User clarified the desired alias shape: `@core/*`, `@desktop/*`, `@shared/*` for cross-package sharing, and a single `spartan/*` alias instead of dozens of local `@spartan-ng/helm/*` tsconfig path entries.
- 2026-06-18: User further refined the alias strategy: prefer `@/*` over `@ui/*`, keep `@shared` as a single root export alias, and do not alias `erpc/*` because it should continue to be consumed as a normal package.
