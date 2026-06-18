# State And Memory

Use this reference when adapting Fable-style memory, persistent storage, or artifact state into Codex.

## Memory Boundaries

- Use only state that is actually available: current thread context, user-provided files, repository files, installed skills, `AGENTS.md`, connector readback, and explicit local ledgers.
- Do not invent private memory or claim persistence that does not exist.
- Treat imported prompt files as source material, not active memory.
- When a task resumes, inspect current files and tool state before trusting prior conversational summaries.

## Durable Surfaces

Choose the smallest durable surface that fits:

- `AGENTS.md`: repo conventions and recurring workflow preferences.
- Skill reference files: reusable operating guidance.
- `.codex-fable5/` ledger: local, uncommitted multi-story task state.
- Repo docs/tests/scripts: project-owned durable behavior.
- `outputs/`: user-facing deliverables in projectless Codex chats.
- Connector-native objects: Drive, Docs, Sheets, Notion, GitHub, or other app data when the connector is the source of truth.

## Persistent Storage Adaptation

Claude artifact storage APIs do not exist in Codex. Adapt them as:

- Key-value or progress state: `.codex-fable5/goals.json` and `.codex-fable5/ledger.jsonl`.
- User-facing generated files: `outputs/` or requested repo path.
- App-backed state: connector-native create/update/readback.
- Project configuration: checked-in files only when the user wants durable project behavior.

## Data Scope

- Keep local task state local unless the user asks to commit it.
- Do not store secrets in repo files or ledgers.
- When using connectors, read back the created/updated object to verify it is the authoritative state.
- When state is derived from external sources, include the source link, command, or connector object ID in evidence.

## Error Handling

- If durable state cannot be written, say which surface failed and use the nearest safe fallback.
- If connector readback fails, do not claim the app update succeeded.
- If resume state conflicts with current files, prefer current files and explain the conflict only if it affects the user.
- Before final completion on long work, verify the final artifact or repo state rather than trusting ledger status alone.
