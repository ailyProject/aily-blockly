## Goal

Clean up redundant JSDoc type annotations in TypeScript sources that trigger `ts(80004)` and align repository guidance so JSDoc in `.ts` files keeps semantic descriptions but does not restate parameter or return types already declared in TypeScript signatures.

## Constraints

- Follow repository AGENTS guidance.
- Preserve useful Chinese descriptions in JSDoc.
- Update both code and documentation rules together.
- Avoid changing runtime behavior.

## Findings

- Current matches are concentrated in `packages/core/**`.
- `REFACTOR.md` and `.codex/GLOBAL.md` still allow `@param` / `@returns` broadly, but do not explicitly forbid redundant type declarations in TypeScript.
- The target warning is caused by tags like `@param {string} value` and `@returns {boolean}` when the TypeScript signature already carries those types.

## Execution Plan

1. Remove `{type}` fragments from `@param`, `@returns`, and `@return` tags in TypeScript files.
2. Preserve tag names and Chinese description text after the parameter name.
3. Update repository docs to state that TypeScript JSDoc should not repeat field, parameter, or return types already expressed in TS syntax.
4. Re-scan the repository for remaining redundant JSDoc type tags in the target scope.

## Progress

- 2026-06-17: Initial scan completed. Code files and docs identified.
- 2026-06-17: Removed redundant JSDoc type fragments from matching TypeScript files in `packages/core/**`.
- 2026-06-17: Removed empty `@returns` tags that remained after type cleanup.
- 2026-06-17: Updated `REFACTOR.md` and `.codex/GLOBAL.md` to forbid repeating TS-declared types inside JSDoc.
- 2026-06-17: Repository re-scan found no remaining `@param {T}` / `@returns {T}` style tags in `.ts` files.
- 2026-06-17: Follow-up scan found additional `.ts` files with redundant JSDoc type tags; cleaned them repo-wide.
- 2026-06-17: Updated `REFACTOR.md` to explicitly forbid generic placeholders and utility types inside TypeScript JSDoc tags.
- 2026-06-17: Simplified `.codex/GLOBAL.md` so refactor-specific guidance points to `REFACTOR.md`, and removed the `polywise` path reference there.
