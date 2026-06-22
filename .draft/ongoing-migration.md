# Ongoing Migration Continuity

## Goal

Continue the legacy rewrite until the monorepo migration is functionally complete:

- Split legacy business logic into the correct subpackages instead of concentrating it under `app` or `desktop`.
- Keep `packages/core` as the main domain/runtime package, with folder-scoped RPC such as `core.project.*`, `core.hardware.*`, `core.serial.*`, `core.ffs.*`, `core.connection.*`, and `core.agent.*`.
- Keep `packages/desktop` thin: Electron runtime, preload, host capabilities, terminal/utility-process bridge, and ERPC only.
- Keep frontend code in `packages/ui/src` without a nested `app` directory, using Angular 22, signals, Tailwind CSS, and Spartan-style components.
- Keep shared contracts, constants, and cross-runtime DTOs in `packages/shared`.
- Align Hono + tRPC + ERPC naming and routing with `/Users/xiewendao/Documents/Projects/polywise/`.
- Support turbo `dev`/`build`, desktop packaging, GitHub tsflows, and release package trimming.
- Finish with review, DeepWiki/legacy alignment, large-file diagnostics, fixes, and a root refactor report.

## Hard Constraints

- Do not create a repository-root `.pnpm-store`.
- Do not revert existing dirty work unless the user explicitly asks.
- Treat `REFACTOR.md` as the primary baseline.
- Use `legacy_deepwiki/` and `/Users/xiewendao/Documents/aily/aily-blockly/` as legacy behavior references.
- Follow `.codex/GLOBAL.md`: type-first TS, no casual `any`/`unknown`, one RPC action per file, anonymous default procedure exports, domain routers with `index.ts`, no JSDoc type restatement, prefer stateless functions, keep files under 180 lines where practical.
- If build errors cannot be fully cleared after reasonable effort, continue the migration and document residual blockers.

## Current Observations

- The worktree is already dirty with extensive migration edits across `core`, `desktop`, `ui`, `shared`, `erpc`, workflows, and package metadata.
- `packages/ui/src` is already flattened; there is no `packages/ui/src/app` directory in the current file list.
- Current UI still has `core-service` and `desktop-service` directories. The user asked to move the two handlers directly under `ui/src/utils` and export them as functions instead of service folders.
- `packages/core/src/rpc` already has several domain directories. Further work should avoid adding flat `app` procedures unless the capability is truly global app configuration.
- `packages/desktop` already contains core service management and terminal domains; it needs to be checked against the polywise utility-process pattern.
- Root `.pnpm-store` was not found during the initial scan.

## Next Actions

1. Run current build/type checks to identify hard blockers.
2. Inspect polywise RPC, desktop utility process, tsflows, and trim-package patterns.
3. Move UI core/desktop RPC handlers from service directories to `src/utils` while preserving call sites through narrow aliases or direct imports.
4. Check and fix RPC exports/naming where they drift from the one-action/one-file default-export pattern.
5. Check file sizes and split large touched files that exceed the `GLOBAL.md` baseline.
6. Run focused build verification again.
7. Use the review skill, then compare DeepWiki and legacy source coverage for missing behavior.
8. Fix accepted review/alignment issues.
9. Write the root refactor report.

## Progress

- Baseline references read: `REFACTOR.md`, `legacy_deepwiki/README.md`, `.codex/GLOBAL.md`, existing `.draft/core-migration-plan.md`.
- Skills read: `fable`, `angular-developer`, `spartan-ng-developer`.
