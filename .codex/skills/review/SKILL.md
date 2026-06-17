---
name: review
description: Review uncommitted code changes to find unreasonable design, unfinished requirements, potential bugs, missed reuse opportunities, and optimization opportunities. Use when the user asks for a review of pending, uncommitted, or unpublished code changes and expects both findings and concrete improvements.
---

# Review

Inspect the current working tree before making assumptions. Start with `git status --short`, then read the relevant diff.

Prioritize findings over summaries. Report the highest-impact issues first with precise file references and concrete impact.

Check these areas on every run:

- Find unreasonable or fragile design choices.
- Find unfinished requirements or behavior gaps.
- Find potential bugs, regressions, and edge-case failures.
- Find duplicated logic or places where existing code should have been reused.
- Find missing validation, verification, or tests.

When the user expects action instead of commentary, fix the issues you identify and re-check the result.

When reviewing, keep the response structure tight:

- List findings first, ordered by severity.
- Add open questions or assumptions only if they materially affect correctness.
- Add a short change summary only after the findings or fixes.

When no issues are found, say so explicitly and still mention residual risks or missing verification.
