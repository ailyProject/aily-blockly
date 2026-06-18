# Provenance

This project is a Codex-native adaptation. It borrows ideas, not source prompt priority.

## Sources Consulted

- `elder-plinius/CL4R1T4S`, `ANTHROPIC/CLAUDE-FABLE-5.md`, commit `dc626fed52b06d687cdc812d51090c95ed03d575`.
- `fivetaku/fablize`, commit `15912466994e71a234d18fe9c74b46a68fb6a07d`.
- `itsinseong/value-for-fable`, commit `35a9bd27de961a49c343f41ac47c49114d51a328`.

## Adapted Ideas

From `fablize`:

- Verification grounding for renderable or executable artifacts.
- Multi-story evidence checkpoints with a final verification gate.
- Reproduce-first investigation with competing hypotheses.
- Early-stop prevention: do the promised work or state the exact blocker.
- Capability-ceiling honesty: procedure cannot create model capability.

From `value-for-fable`:

- Value-aware routing rather than model imitation.
- Outcome-first readable communication.
- Clue-first diagnosis and cheapest discriminating measurement.
- Optional 2-pass review for high-cost misses.
- Evidence-backed findings closeout for review issues.
- Long-session drift awareness.
- Avoiding over-compression when readability and completeness matter.

## Licensing Notes

- `CL4R1T4S` and `value-for-fable` are AGPL-3.0-family sources. This project remains AGPL-3.0-or-later.
- `fablize` advertises MIT licensing in its README at the inspected commit. Its code ideas are compatible with this AGPL project, but keep attribution.
- Do not paste large sections of upstream prompt or documentation text into generated user answers. Paraphrase and cite.
