---
name: blockly-project-planning
description: "Blockly project planning and creation workflow for no-project hardware requests. Trigger words: create project, new Blockly project, board selection, library selection, hardware plan, LED blink, sensor, actuator"
metadata:
  version: "1.0.0"
  author: aily-team
  scope: global
  agents: mainAgent
  auto-activate: false
  tags: blockly,project-planning,board-selection,library-selection,hardware
---

# Blockly Project Planning Workflow

Use this skill when no project is open and the user asks for a hardware/Blockly result that may require creating a project.

Required order:

1. Understand the request and decide whether it requires a new Blockly project.
2. Search for concrete development board package names with the board/library discovery tools.
3. Search for concrete library package names required by the feature. If no extra library is required, explicitly say that core libraries are enough.
4. Build 2-3 viable board/library combinations when alternatives exist. If only one combination is practical, explain why.
5. For each candidate, outline the architecture and workflow: board, libraries, wiring or pin assumptions, ABS/workspace structure, validation steps, and safety notes.
6. Present the candidate plans to the user and ask them to choose or confirm one.
7. Only after the user chooses or confirms a plan may you create the project, install libraries, or edit workspace files.

Important restrictions:

- Do not ask the user to choose a development board before using discovery tools to find candidate board package names.
- Do not invent board or library package names.
- Do not call project creation tools before the user has chosen or confirmed a candidate plan.
- In Plan mode, stop after producing the candidate plan and user-choice question. Do not create the project or make edits.
- For simple requests such as LED blink, still search for board candidates if a project must be created. A simple feature does not remove the no-project planning workflow.

Recommended output shape before asking the user:

- Option A: board package, required libraries, wiring/pin assumptions, implementation outline, pros/cons.
- Option B: board package, required libraries, wiring/pin assumptions, implementation outline, pros/cons.
- Option C: optional when a third viable path exists.
- Recommendation: one short default choice and why.
- User choice request: use [ask question] tool to ask the user to select an option or confirm the recommendation.
