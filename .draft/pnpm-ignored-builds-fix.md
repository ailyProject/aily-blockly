## Goal

Fix git commit failures caused by pnpm build-script approval checks during the pre-commit hook.

## Findings

- The git pre-commit hook only runs `pnpm exec pretty-quick ...`.
- The failure happens before `pretty-quick` runs because pnpm 11 performs a dependency status check.
- `pnpm-workspace.yaml` still contains unresolved placeholder values under `allowBuilds`:
  - `@parcel/watcher`
  - `less`
  - `lmdb`
  - `msgpackr-extract`
- These packages are all pulled in by the Angular/Nx/Spartan toolchain in `packages/ui`.

## Plan

1. Replace the unresolved placeholder values with explicit booleans.
2. Add the same packages to `onlyBuiltDependencies` so pnpm does not keep treating them as ignored.
3. Run `pnpm install` to verify the dependency-status check passes again.

## Progress

- 2026-06-18: Investigated the pre-commit hook and confirmed the failure originates from pnpm build approval policy checks.
