## Goal

Restrict GitHub workflow generation so this repository only keeps the desktop packaging workflow, with manual trigger only, and only for the `xwd-experimental` branch.

## Findings

- Workflow sources live under `.github/tsflows/`.
- Current sources:
  - `desktop.ts`
  - `standalone.ts`
- Generated workflow files live under `.github/workflows/`.
- `desktop.ts` currently runs on `push` to `main`, `master`, and `xwd-experimental`, plus `pull_request`.
- `standalone.ts` currently runs on `workflow_dispatch` and `push`.

## Plan

1. Change `desktop.ts` to use `workflow_dispatch` only.
2. Add a job-level branch guard so the workflow only executes on `xwd-experimental`.
3. Remove `standalone.ts`.
4. Remove `standalone.generated.yml`.
5. Regenerate workflows from the remaining tsflow sources.

## Progress

- 2026-06-18: Inspected tsflow sources and generated workflow outputs.
