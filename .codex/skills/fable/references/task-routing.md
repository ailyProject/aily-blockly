# Task Routing

This reference adapts the useful procedural ideas from `fablize` and `value-for-fable` to Codex. Apply the smallest discipline that matches the task. Do not inject every rule into every turn.

## Routing Table

| Signal                                                                                                            | Apply                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 2+ dependent stories, migration, multi-file feature, long autonomous work                                         | Use the goal ledger and final verification gate.                                                           |
| Debugging, regression, flaky test, "why", "root cause", unknown failure                                           | Use the investigation protocol.                                                                            |
| HTML, CSS, SVG, game, canvas, chart, UI, animation, local app                                                     | Use verification grounding: run, observe, fix, re-run after changes.                                       |
| Diagnosis, architecture decision, product/technical tradeoff                                                      | Use VFF operating structure: conclusion first, clue-first hypothesis, cheapest discriminating measurement. |
| High-stakes or deep unfamiliar domain                                                                             | Suggest higher reasoning or stronger model; optionally use 2-pass review.                                  |
| Review requested, failed/uncertain verification, security-sensitive change, or multi-file work with costly misses | Use the findings ledger and gate.                                                                          |
| Simple one-step edit or factual answer                                                                            | Keep the normal Codex loop; do not add goal files or extra process.                                        |

## Goal Ledger

Use `scripts/codex_goals.py` when there are multiple dependent stories and the task benefits from resume-safe state.

For user-facing terminal use from a checkout, add `plugins/fable/bin` to `PATH` and use `codex-fable5 goals`.

Example:

```bash
codex-fable5 goals create --brief "Add CSV import" \
  --goal "inspect::Find current import flow and tests" \
  --goal "implement::Add CSV parser and UI path" \
  --goal "verify::Run tests and a sample import"
codex-fable5 goals next
codex-fable5 goals checkpoint --id G001 --status complete --evidence "Read importer.ts and import.test.ts"
codex-fable5 goals next
```

Rules:

- Work only the active story.
- A complete checkpoint requires concrete evidence.
- The final story requires `--verify-cmd` and `--verify-evidence`.
- On resume, run `status` first.
- Store local state under `.codex-fable5/`; do not commit it unless the user asks.

## Findings Ledger

Use `scripts/codex_findings.py` when review or verification produces evidence-backed issues that must not be lost before final completion.

For user-facing terminal use from a checkout, add `plugins/fable/bin` to `PATH` and use `codex-fable5 findings`.

Example:

```bash
codex-fable5 findings add \
  --title "Final checkpoint can pass with unresolved review issues" \
  --severity high \
  --source subagent \
  --evidence "Review found that the final gate only checks tests, not accepted findings."
codex-fable5 findings next
codex-fable5 findings resolve \
  --id F001 \
  --evidence "Added a findings gate before final checkpoint." \
  --verify-cmd "python3 -m unittest discover -s tests -v" \
  --verify-evidence "all tests passed"
codex-fable5 findings gate
```

Rules:

- Treat findings as accepted repair work, not brainstorming notes.
- Add only evidence-backed missing requirements, regressions, factual/source errors, failed checks, or unexplained clues.
- When a goal is active, new findings attach to that goal automatically unless `--goal` is provided.
- Resolve findings only after the normal inspect/change/verify loop produces resolution evidence and verification evidence.
- Run `gate` before completing a final goal checkpoint when accepted findings may remain.
- Final `codex-fable5 goals checkpoint --status complete` also fails while open or blocked findings remain.
- By default, `gate` fails on open or blocked findings. Use `--allow-blocked` only when the remaining blocked findings are explicitly accepted as residual risk.
- Store local state under `.codex-fable5/`; do not commit it unless the user asks.

## Investigation Protocol

For unknown-cause debugging:

1. Reproduce first. Run or inspect the actual failing path before choosing a fix.
2. List at least three competing hypotheses.
3. For each hypothesis, identify the evidence that would confirm or refute it.
4. Prefer the hypothesis that explains every clue: timing, intermittency, exact error, concurrency, inputs, and environment.
5. Trace the causal chain past the visible symptom.
6. Verify before and after the fix.
7. Report rejected hypotheses and the evidence that rejected them when the diagnosis matters.

## Verification Grounding

For artifacts whose correctness can only be observed:

- Web/UI: start the app or serve the file, open it in Browser, inspect console and screenshot.
- SVG/chart/image: render or view the output, not only the source.
- CLI/script: run it with representative input and inspect stdout/stderr.
- Game/animation: advance far enough to see state change.

A syntax check is not visual or behavioral observation. After any fix based on observation, run the observation again.

## Early Stop Guard

Before final response, check the closing message:

- If it says "I'll do X next" and X is part of the user's request, do X now.
- If only the user can provide the missing input, name that input exactly and stop.
- Do not end with trailing plans, offers, or promises after verified completion.

## Capability Ceiling

Procedure cannot supply missing model capability. Escalate when:

- The same failure repeats after two serious attempts.
- The value is open-ended creative depth rather than verifiable correctness.
- The task requires out-of-spec defect discovery or unfamiliar expert knowledge.
- A small model lacks domain knowledge even after source gathering.

Escalation options in Codex: raise reasoning effort when available, switch to the strongest configured model, use a focused review pass, or hand the evidence package to a human.
