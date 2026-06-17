# AGENTS

## Refactor Baseline

- All rewrite and decomposition work must treat `REFACTOR.md` as the primary baseline reference.
- Before redesigning a legacy subsystem, review `REFACTOR.md` for the frozen `scc` statistics, the archived DeepWiki document set, and the original source repository path.
- Use `legacy_deepwiki/README.md`, the full `legacy_deepwiki/` archive, and `/Users/xiewendao/Documents/aily/aily-blockly/` as legacy references during the refactor. Do not treat the deleted implementation as an implicit contract without first checking `REFACTOR.md`.

## Complex Task Continuity

- When a task is sufficiently complex that it requires multi-step analysis, decomposition, or extended execution, store the working analysis and a concrete executable plan under the repository root `.draft/` directory.
- The stored notes should be detailed enough that work can be resumed after an interruption without re-discovering the original objective, assumptions, current status, and next actions.
- Keep the `.draft/` contents focused on actionable continuity: task goal, constraints, findings, pending decisions, ordered execution steps, and current progress.
