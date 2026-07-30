---
name: blockly-best-practices
description: "Aily Blockly implementation workflow for scoped library evidence, ABS editing, workspace synchronization, and focused validation. Use for creating or modifying Blockly/ABS programs."
metadata:
  version: "2.0.0"
  author: aily-team
  scope: global
  agents: mainAgent
  auto-activate: false
  tags: blockly,coding-standards,abs,workflow
---

# Blockly Implementation Workflow

Use this skill only for implementing or modifying a Blockly/ABS program. Project selection and creation belong to the `blockly-project-planning` skill.

## 1. Start from runtime facts

- Treat the injected project path, current board, installed library list, `readme_ai.md` references, and `project.abs` path as current runtime facts.
- Do not call tools merely to rediscover those facts.
- Treat `project.abs` as the canonical editable Blockly source. Generated `.ino`/C++ is derived output used for diagnostics, not the normal edit target.

## 2. Gather only task-relevant evidence

- Identify the smallest set of libraries needed for the current feature. Do not inspect every installed library or add `lib-core-*` packages speculatively.
- For each relevant installed library, call `analyzeLibrary` with `mode="auto"` first.
- When it returns a `readme_ai.md` reference, read that file. The README is usually sufficient, but it is not an absolute stopping point.
- If the README is missing, incomplete, contradictory, or does not answer the current question, escalate narrowly:
  1. inspect the relevant `block.json` for block types, fields, inputs, and `args0` order;
  2. inspect `generator.js` only when generated-code semantics remain unclear;
  3. inspect the minimum native source needed only when underlying library behavior remains unresolved.
- Stop reading once the evidence answers the current implementation question.

## 3. Resolve board facts through the board capability source

- Use `get_board_parameters` for GPIO, ADC, PWM, UART, I2C, SPI, builtin LEDs, and other board defaults. Its `board.json` result is authoritative.
- Pinmap data describes schematic terminals and connection geometry. Do not use it as the source of MCU capability or default-pin facts.
- Use schematic/pinmap capabilities only when the request actually requires wiring or a connection diagram.

## 4. Edit the canonical ABS source

1. Read `project.abs` directly. The host synchronizes the visible Blockly workspace to this file before a submitted turn.
2. Use `syncAbs action="export"` only if the workspace may have changed after the turn began or a status check shows drift.
3. Make the smallest coherent ABS edit. Preserve unrelated blocks and structure.
4. Use `syncAbs action="import"` to apply the updated ABS to the visible workspace.
5. Treat parse warnings, failed blocks, degraded text expressions, or partial imports as failed validation and repair them before continuing.

Load `abs-syntax-reference` when block argument order, statement inputs, nested value blocks, or other non-trivial ABS grammar is involved. Do not guess positional arguments; verify them from the selected library evidence.

## 5. Validate immediately

- Check the imported workspace/ABS structure after a non-trivial change.
- Run `lint` for generated-code syntax validation when appropriate.
- Run `buildProject` when the task requires a compile result.
- If validation fails, use the nearest error and the smallest relevant source as the next evidence anchor. Do not restart broad project exploration.

## Completion criteria

- The visible workspace reflects the intended ABS structure.
- No ABS import warning or failed block remains.
- Requested focused validation passes, or the remaining blocker is reported precisely.
- Do not claim completion from compiler success alone when the Blockly import was partial or structurally degraded.
