# Connectors And MCP

Use this reference when adapting Fable-style MCP app suggestions, connector discovery, or third-party tool routing.

## Routing Order

1. Use installed app/plugin capabilities already exposed in the current Codex session.
2. Use `tool_search` when the user asks for a tool-backed action and the tool is not already loaded.
3. Use connector readback for private workspace data instead of public web search.
4. Use plugin install flow only when the user explicitly asks for a specific plugin/connector that is not available.
5. Fall back to public web only when the needed data is public/current and no private connector is required.

## Direct Connector Calls

Call an app/MCP tool directly when:

- The user names that app or gives an app URL/object.
- The data/action lives in the app, such as a GitHub PR, Google Drive file, Figma canvas, Notion page, or Canva design.
- The active tool schema supports the exact read/write operation needed.

Read the relevant skill first when a plugin skill says it is mandatory for the operation.

## Opt-In And Installation

- Do not imply a connector is installed until the active tool list or `tool_search` proves it.
- Do not request plugin install for adjacent capabilities or broad recommendations.
- If a requested connector is missing and no install flow is available, explain the gap and use the best safe fallback.
- Do not fabricate marketplace results, app IDs, credentials, or tool output.

## What To Avoid

- Do not browse public web for private workspace data that should come from a connector.
- Do not ask the user to manually export app data before trying the available connector.
- Do not convert every task into an app suggestion; use connectors only when they materially help.
- Do not preserve Claude-specific connector names or policies as active instructions.

## Expected Feel

Connector routing should be quiet and practical: use the tool, verify the result, and report the outcome. Mention routing details only when they affect setup, permissions, evidence, or a limitation.
