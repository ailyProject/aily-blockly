## Goal

Move all in-repo skills into the repository root `.codex/skills` directory and ensure no package-local or alternate skill roots remain.

## Source and Target

- Source reference repo: `/Users/xiewendao/Documents/aily/aily-blockly/`
- Legacy source skill root discovered: `/Users/xiewendao/Documents/aily/aily-blockly/public/skills`
- Current in-repo skill roots discovered during migration:
  - `/Users/xiewendao/Documents/aily/aily-blockly-experimental/.codex/skills`
  - `/Users/xiewendao/Documents/aily/aily-blockly-experimental/codex/skills`
- Final target skill root: `/Users/xiewendao/Documents/aily/aily-blockly-experimental/.codex/skills`

## Findings

- Current rewrite repo does not contain `app/skills`, `public/skills`, or package-local skill directories.
- Current rewrite repo has the canonical root-local skill location at `.codex/skills/`.
- A temporary mistaken root-local skill location at `codex/skills/` was created during migration and then removed.
- Legacy repo contains three skills under `public/skills`:
  - `abs-syntax-reference`
  - `blockly-best-practices`
  - `library-migration-guide`
- `review` existed in both `.codex/skills/review` and `codex/skills/review` during migration; these were treated as the same skill and consolidated under `.codex/skills/review`.

## Execution Plan

1. Inspect all current and legacy skill directories that should feed the unified root location.
2. Merge file trees into `.codex/skills/<skill-name>` file-by-file.
3. Remove old in-repo skill roots once their content has been consolidated.
4. Re-scan the repository to verify `.codex/skills` is the only remaining in-repo skill root.

## Progress

- 2026-06-17: Located legacy `public/skills` in the frozen source repository.
- 2026-06-17: Confirmed the current rewrite repo only contains `.codex/skills/review`.
- 2026-06-17: Created a temporary `codex/skills` and copied in legacy frontend-facing skills plus `review`.
- 2026-06-17: User clarified the repository rule: no skills may remain in subpackages or alternate local roots; all in-repo skills must live under root `.codex/skills`.
- 2026-06-17: Moved all consolidated skills back into `.codex/skills` and removed the mistaken `codex/skills` root.
- 2026-06-17: Removed the unnecessary legacy local skills so `.codex/skills` temporarily returned to `review` only.
- 2026-06-17: User clarified that project-relevant `fable`, `angular`, and `spartan` skills should be local to this repository rather than relied on from the global Codex home.
