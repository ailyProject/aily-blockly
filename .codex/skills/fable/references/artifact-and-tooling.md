# Artifact And Tooling

Use this reference when adapting Fable-style computer use, artifact, file, image, package, or tool-schema instructions to Codex.

## Tool Principles

- Use the actual tools available in the current Codex session. Do not preserve Claude tool names or schemas.
- Read before editing. Use `rg` or `rg --files` for local search when possible.
- Use `apply_patch` for manual file edits and new manual text/code files.
- Use format-specific skills or app connectors for documents, presentations, spreadsheets, Figma, Canva, Drive, Notion, GitHub, or browser workflows when available.
- Use shell commands for scoped inspection, tests, builds, formatters, and deterministic scripts.

## Files And Outputs

- In a repository, edit the requested repo files directly.
- In projectless Codex chats, use `work/` for scratch and the configured `outputs/` directory for user-facing deliverables.
- Link real files or pushed URLs in final responses. Do not tell the user to copy local files from the shared workspace.
- Do not assume Claude artifact storage exists. Use filesystem paths, repo commits, generated assets, or connector-native objects.

## Renderable Artifacts

For UI, SVG, image, chart, game, animation, document, deck, spreadsheet, or local app output:

- Build or render the artifact in its natural environment.
- Observe it with Browser, image viewing, document rendering, app connector readback, or command output.
- Treat syntax checks as insufficient for visual or behavioral correctness.
- After fixing an observed issue, re-run the observation.

## Package Management

- Inspect the existing project before adding dependencies.
- Follow the lockfile and package manager already used by the repo.
- Prefer existing helpers and local patterns.
- Add dependencies only when they materially reduce risk or complexity.
- Verify with the repo's relevant test, lint, typecheck, build, or smoke command.

## Tool Mapping Notes

- Text file view: shell reads such as `sed`, `rg`, `ls`, or connector readback.
- Image view: local image viewing tool or Browser screenshot.
- Shell execution: Codex shell tool.
- Manual edit: `apply_patch`.
- File presentation: `outputs/`, repo paths, or pushed URLs.
- Web fetch/search: active web tools when browsing is required.
- Sports, weather, places, and other current facts: use available specialized tools or current primary sources.
- Message composition and recipe display widgets: no direct Codex equivalent; draft structured text/files or use an installed connector if one exists.
- Maps/place display widgets: no guaranteed direct widget; provide links, files, or app-specific outputs supported by active tools.

## Anthropic Or Fable APIs In Generated Apps

- Never assume hidden Anthropic credentials or provider access.
- If the user supplies an authorized endpoint, isolate the configuration and document required environment variables.
- Prefer OpenAI APIs for OpenAI/Codex examples unless the user explicitly requests a different provider.
- Keep provider bridge guidance separate from core workflow behavior.
