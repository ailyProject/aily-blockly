---
name: chronicle
description: Analyze indexed Aily chat session history for prior decisions, tool executions, project summaries, usage tips, and session-store reindexing.
---

# Chronicle

Use this skill when the user asks about previous conversations, earlier project
decisions, prior tool executions, compacted-away details, generated artifacts,
daily summaries, usage/workflow tips, or rebuilding the local session index.

Chronicle is separate from `memory_tool`:

- `memory_tool` reads and writes explicit notes under `/memories/...`.
- `session_store_sql` queries the read-only indexed session store containing
  saved turns, checkpoints, files, refs, tool requests, and artifacts.

## Tool

Use `session_store_sql`.

Actions:

| Action | Purpose | Required input |
|---|---|---|
| `query` | Execute one read-only SQL query | `description`, `query` |
| `reindex` | Rebuild the local index from saved session history | `description`, optional `force` |

Only call `action="reindex"` when the user asks to rebuild the index, or when
query results look stale and you explain why reindexing is needed.

## Local SQLite Query Rules

- Queries are read-only.
- Use exactly one statement.
- Use only `SELECT` or `WITH`.
- Use `datetime('now', '-1 day')` for local date math.
- Do not use DuckDB syntax such as `now() - INTERVAL`.
- Use `search_index MATCH ...` for FTS search over indexed turn/checkpoint
  content.
- Use `LIKE` for file paths, refs, and Chinese/no-whitespace fallback searches.
- Escape single quotes in user text by doubling them.

## Tables

### `sessions`

One row per indexed session.

Important columns:

- `id`: session id
- `cwd`: working directory
- `repository`: repository label when known
- `host_type`: host/client label
- `branch`: branch label when known
- `summary`: session summary when available
- `agent_name`, `agent_description`: agent surface metadata
- `created_at`, `updated_at`

### `turns`

One row per indexed turn.

Important columns:

- `session_id`
- `turn_index`
- `user_message`
- `assistant_response`
- `timestamp`

### `checkpoints`

Compaction/checkpoint summaries.

Important columns:

- `session_id`
- `checkpoint_number`
- `title`
- `overview`
- `history`
- `work_done`
- `technical_details`
- `important_files`
- `next_steps`
- `created_at`

### `session_files`

Files touched or referenced by tools.

Important columns:

- `session_id`
- `file_path`
- `tool_name`
- `turn_index`
- `first_seen_at`

### `session_refs`

Lightweight external references extracted from turns.

Important columns:

- `session_id`
- `ref_type`
- `ref_value`
- `turn_index`
- `created_at`

### `tool_requests`

Tool-call audit rows.

Important columns:

- `session_id`
- `turn_index`
- `tool_call_id`
- `tool_name`
- `arguments`
- `result`
- `state`
- `created_at`

### `search_index`

FTS table for session text and artifacts.

Important columns:

- `content`
- `session_id`
- `project_path`
- `source_type`
- `source_id`
- `turn_index`
- `title`
- `created_at`

## Common Queries

Search previous sessions for a topic:

```sql
SELECT session_id, source_type, title, substr(content, 1, 300) AS excerpt
FROM search_index
WHERE search_index MATCH '"command_exec" OR "terminal"'
ORDER BY created_at DESC
LIMIT 10
```

Find recent sessions:

```sql
SELECT id, cwd, summary, updated_at
FROM sessions
WHERE updated_at >= datetime('now', '-7 days')
ORDER BY updated_at DESC
LIMIT 20
```

Find prior command-line tool executions:

```sql
SELECT session_id, turn_index, tool_name, arguments, state, created_at
FROM tool_requests
WHERE tool_name IN ('command_exec', 'run_in_terminal')
ORDER BY created_at DESC
LIMIT 20
```

Find sessions that touched a file:

```sql
SELECT s.id, s.summary, f.file_path, f.tool_name, f.first_seen_at
FROM session_files f
JOIN sessions s ON s.id = f.session_id
WHERE f.file_path LIKE '%project.abs%'
ORDER BY f.first_seen_at DESC
LIMIT 20
```

Find checkpoint summaries:

```sql
SELECT session_id, checkpoint_number, title, overview, created_at
FROM checkpoints
ORDER BY created_at DESC
LIMIT 20
```

Chinese/no-whitespace fallback search:

```sql
SELECT session_id, source_type, title, substr(content, 1, 300) AS excerpt
FROM search_index
WHERE content LIKE '%命令行%' OR content LIKE '%工具%'
ORDER BY created_at DESC
LIMIT 10
```

Token/usage analysis when usage columns are present:

```sql
SELECT s.agent_name,
       SUM(e.usage_input_tokens) AS input_tokens,
       SUM(e.usage_output_tokens) AS output_tokens,
       e.usage_model
FROM events e
JOIN sessions s ON s.id = e.session_id
WHERE e.event_type = 'assistant.usage'
GROUP BY s.agent_name, e.usage_model
ORDER BY input_tokens + output_tokens DESC
LIMIT 20
```

If the local store does not contain usage columns, say that token-level analysis
is unavailable in the current index and use proxies such as long sessions,
large `turns.user_message`, repeated `session_files`, and repeated
`tool_requests`.

## Workflows

### Search

When the user asks whether something happened before, search the current
project/session index with `session_store_sql`. Prefer FTS `search_index` for
free-text history and join to `sessions` only after you have candidate
`session_id`s. Also check `tool_requests`, `session_files`, and `session_refs`
when the user's question mentions tools, files, PRs, issues, commits, or
artifacts.

If no results are found, say that the indexed history does not contain evidence.
Do not claim the event never happened outside the indexed scope.

### Standup / Summary

For daily or project summaries, first query recent `sessions`, then enrich with
`turns`, `checkpoints`, `session_files`, and `session_refs`. Keep the summary
grounded in the rows returned by `session_store_sql`.

### Workflow Tips

For usage or workflow tips, inspect recent sessions, turn counts, repeated file
touches, and repeated tool requests. Provide only recommendations grounded in
observed rows.

### Reindex

If the user asks to rebuild or refresh the session index, call:

```json
{
  "action": "reindex",
  "description": "Rebuild local Chronicle session index",
  "force": true
}
```

After reindexing, report the before/after stats and retry the user's intended
query if appropriate.
