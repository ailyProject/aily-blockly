# Refactor Baseline

This repository was reset on 2026-06-17 on branch `xwd-experimental` to start a full rewrite from a clean slate.

## Core Refactor Principle

The highest-priority rule during this rewrite is to avoid breaking already implemented functionality.

- Implementation details, module boundaries, abstractions, package layout, and internal designs may be changed when doing so improves maintainability, clarity, performance, or long-term architecture.
- Final user-visible behavior, supported workflows, and already delivered functional outcomes must remain intact unless an intentional product change is explicitly approved.
- When there is tension between architectural cleanup and functional compatibility, preserve compatibility first and adjust the refactor plan rather than shipping a behavioral regression.
- If expected legacy behavior is unclear, verify it against `legacy_deepwiki/`, `legacy_deepwiki/README.md`, and `/Users/xiewendao/Documents/aily/aily-blockly/` before treating a change as safe.

## Type-First Implementation Principle

TypeScript implementation in this rewrite must be type-first rather than "make it run first, type it later."

- Do not casually use `any` or `unknown` to bypass type design, suppress uncertainty, or quickly force code through compilation.
- Code should be implemented on top of explicit domain types, input/output contracts, and stable interfaces. Define the types first, then implement against them.
- Do not trade away type completeness just to move faster. The intended baseline is code that is robust, verifiable, and maintainable because its behavior is constrained by types.
- Public types, interfaces, type aliases, DTOs, and other important structured models should also carry JSDoc so later implementation work can understand boundaries from the type layer itself.
- In TypeScript files, JSDoc should explain semantics and constraints rather than restating types that are already declared in TS syntax.
- If a runtime boundary temporarily requires `unknown`, narrow it immediately with parsing, validation, guards, or schema-based decoding before the value is allowed to flow deeper into the codebase.
- `any` should be treated as an exceptional last resort and not as a normal implementation tool during the rewrite.

## Function Comment Principle

Complex functions added or rewritten during this refactor should prefer Chinese comments that explain their purpose and key behavior.

- For complex functions, write Chinese comments to describe responsibility, important inputs and outputs, and non-obvious constraints or side effects.
- Use a standard multi-line JSDoc block when writing these comments, and include `@param` / `@returns` tags only when they add semantic verification value.
- In TypeScript, do not repeat parameter types, return types, or field types inside JSDoc tags such as `@param {T}`, `@returns {T}`, or field-level type restatements; keep the description text only.
- The same rule applies to generic placeholders, utility types, and inline object types inside JSDoc. Do not write tags such as `@param {Array<T>}`, `@returns {Record<string, T>}`, `@returns {ReturnType<typeof foo>}`, or `@param {Parameters<typeof foo>[0]}` in `.ts` files.
- Apply the same JSDoc style to important type declarations such as interfaces, type aliases, DTOs, configuration models, and event payloads.
- Do not stop at a one-line summary for the whole type: important public fields should also have field-level JSDoc that explains business meaning, units, constraints, or optional semantics, but should not redundantly restate the field's TS type.
- For union types, especially string literal unions, document the meaning of each exposed literal value instead of only documenting the union as a whole.
- Comments should improve readability and verification, not restate trivial syntax line by line.
- Prefer a short Chinese summary comment above complex functions rather than leaving intent implicit in implementation details alone.
- Do not add repetitive comments to every small helper just to satisfy a blanket rule.

## Reference Inputs

- Frozen source repository path for legacy lookup: `/Users/xiewendao/Documents/aily/aily-blockly/`
- Archived DeepWiki document index: `legacy_deepwiki/README.md`
- Archived DeepWiki full document set: `legacy_deepwiki/`
- DeepWiki source URL: `https://deepwiki.com/ailyProject/aily-blockly/1-overview`
- DeepWiki page metadata generation time: `2026-06-10T07:45:14.433491`
- DeepWiki snapshot retrieval date: `2026-06-17`
- Architecture and best-practice reference repository: `/Users/xiewendao/Documents/Projects/polywise/`
- Progressive Blockly optimization guidance directory: `/Users/xiewendao/Documents/aily/aily-blockly-experimental/blockly 渐进式优化方案（多轮）/`

The DeepWiki documentation archive is retained as a refactor-time reference and should be consulted alongside the original source tree when rebuilding modules, boundaries, and workflows. The archive currently contains the full 35-page DeepWiki document set exported from the site payload.

The `polywise` repository is retained as a secondary reference for architecture, project organization, and implementation best practices. For formatting, only its import-sorting Prettier plugin precedent should be inherited here; do not pull in unrelated styling plugins.

The progressive optimization document set under `/Users/xiewendao/Documents/aily/aily-blockly-experimental/blockly 渐进式优化方案（多轮）/` is retained as a "window guidance" reference. It should be used to guide staged decision-making, package boundaries, migration sequencing, and acceptance criteria during the rewrite.

## Legacy SCC Snapshot

```text
Language            Files       Lines    Blanks  Comments       Code Complexity
───────────────────────────────────────────────────────────────────────────────
TypeScript            425     164,825    17,725    24,130    122,970     20,587
Sass                  112      19,960     2,954       723     16,283          0
HTML                  111       8,069       283       791      6,995          0
JSON                  108      12,922         0         0     12,922          0
JavaScript             55      18,894     1,800     2,845     14,249      2,424
CSS                    33      58,509    18,809       175     39,525          0
Markdown               28       5,360     1,149         0      4,211          0
YAML                    3       1,415       176        91      1,148          0
License                 1         674       121         0        553          0
SVG                     1           1         0         0          1          0
TypeScript Typ…         1          40         1         1         38          0
XML                     1          32         6         9         17          0
───────────────────────────────────────────────────────────────────────────────
Total                 879     290,701    43,024    28,765    218,912     23,011
───────────────────────────────────────────────────────────────────────────────
Estimated Cost to Develop (organic) $7,742,449
Estimated Schedule Effort (organic) 29.94 months
Estimated People Required (organic) 22.98
───────────────────────────────────────────────────────────────────────────────
Processed 13888448 bytes, 13.888 megabytes (SI)
───────────────────────────────────────────────────────────────────────────────
```

## Legacy Style Analysis

The legacy codebase does not appear to be governed by a strong repo-level Prettier setup. Style is mostly enforced by convention, with a clearer baseline in Angular and SCSS files than in standalone Node scripts.

- Indentation is predominantly 2 spaces in TypeScript, HTML, and SCSS. The removed legacy `.editorconfig` also enforced 2-space indentation and UTF-8.
- TypeScript and modern frontend code consistently prefer single quotes and semicolons.
- Multi-line arrays, object literals, and Angular decorator metadata commonly keep trailing commas.
- Angular code favors standalone components, explicit `imports` arrays, class fields declared before the constructor, and getters placed near related state.
- Import grouping is conceptually ordered as framework -> third-party -> app-local, but actual ordering is often manual and inconsistent. This is a good target for automatic import sorting in the rewrite.
- Folder-level `index.ts` barrel exports should be used where they clarify module boundaries and reduce repetitive long import lists across the codebase.
- These barrel files should prefer the `export * from './x'` form by default, and only use named forwarding when handling a real default export.
- Templates prefer Angular's modern control-flow syntax such as `@if`, `@for`, and `@switch`, with compact markup and inline bindings rather than excessive wrapper elements.
- Angular component templates should prefer standalone `.html` files referenced via `templateUrl` instead of inline template strings, because separate template files are easier to read, review, and maintain.
- SCSS is component-scoped, nested, and variable-driven, relying on CSS custom properties like `var(--aily-...)` instead of utility-class-heavy styling.
- Node-side helper scripts under `child/scripts/` are less consistent: they use CommonJS, 4-space indentation in places, and more manual formatting. These files should be treated as legacy exceptions rather than the new baseline.
- Naming is pragmatic rather than purist: service-heavy Angular code, `*.service.ts` modules, and descriptive component filenames dominate. There is also frequent use of `any` in UI code, which should not be carried forward into the rewrite baseline.

## Rewrite Formatting Baseline

The rewrite should preserve the useful parts of the legacy style while making formatting deterministic.

- Treat the repository root `.prettierrc` as the single source of truth for formatting output.
- Preserve Angular-oriented readability: concise decorators, explicit imports, and component-scoped SCSS.
- Prefer external Angular template files (`*.html`) over inline template strings so component structure remains readable at a glance.
- Normalize import ordering automatically instead of relying on manual grouping.
- Prefer folder-level `index.ts` barrel exports so imports target stable module entry points and individual import statements stay smaller and easier to maintain.
- Prefer Chinese JSDoc comments for complex rewritten TypeScript functions when they clarify responsibility or constraints, and keep those comments focused on meaning rather than duplicating TS type annotations.
- Prefer ESM and typed TypeScript for new code unless a runtime constraint forces CommonJS.

At the time of writing, the actual formatter baseline is whatever the current `.prettierrc` encodes. If prose in this document drifts from that file, follow `.prettierrc` and update this document instead of inventing a second formatting standard.

## Prettier Baseline

- Root config files: `.prettierrc` and `.prettierignore`
- Imported precedent: `/Users/xiewendao/Documents/Projects/polywise/package.json`
- Plugin to adopt: `@ianvs/prettier-plugin-sort-imports`
- Deliberate non-goals: Tailwind-specific Prettier plugins and unrelated formatter plugins from `polywise`

The current Prettier setup intentionally uses the same file naming convention as `polywise`: `.prettierrc` and `.prettierignore`. Only `@ianvs/prettier-plugin-sort-imports` is retained from that precedent; Tailwind-specific and other unrelated formatter plugins are intentionally excluded.

## AI Frontend Baseline

The Angular frontend rewrite should standardize on `@ai-sdk/angular` as the default rendering and UI integration layer for AI SDK features in the browser.

- Install and use `@ai-sdk/angular` in the frontend workspace (`packages/ui`) for chat, completion, streaming state, and other Angular-facing AI SDK rendering flows.
- Treat `@ai-sdk/angular` as the default frontend integration choice instead of introducing ad hoc wrapper layers around raw AI SDK browser primitives unless there is a documented gap that requires one.
- Keep the frontend aligned with Angular-native patterns such as standalone components, signals, and template-driven rendering rather than building a React-style abstraction layer on top of Angular.
- If lower-level `ai` package usage is needed for transport or shared logic, keep that usage behind clear boundaries; Angular UI state and rendering should still be driven through `@ai-sdk/angular`.

## Data Interaction Baseline

The rewrite should standardize on `hono` + `trpc` + `erpc` as the primary data interaction stack, following the architectural precedent in `/Users/xiewendao/Documents/Projects/polywise/`.

- Use `hono` as the primary HTTP server framework for service and API entry layers.
- Use `trpc` as the default typed contract layer for request/response boundaries so frontend, backend, and shared modules communicate through explicit end-to-end types.
- Use `erpc` for Electron main/renderer typed IPC interaction instead of introducing ad hoc IPC event contracts.
- Prefer this stack over custom REST handlers, loosely typed fetch wrappers, handwritten RPC conventions, or one-off message channels unless a clearly documented exception is required.
- Shared schemas, router input/output types, and transport contracts should be defined once and reused across callers instead of duplicated at each boundary.
- Do not reintroduce Electron-only BLE globals such as `window.ble`. If the desktop host needs to participate in BLE device selection or permissions, expose that surface through typed `desktop.ble.*` ERPC routes instead.
- Keep BLE responsibilities split by runtime boundary: protocol preparation and upload planning belong in `core`, Electron chooser/permission bridging belongs in `desktop`, and the actual browser-side Web Bluetooth transport belongs in `ui`.

## Reactive State Baseline

The rewrite should avoid making RxJS the default state or orchestration model.

- Prefer Angular Signals, plain functions, and simple explicit state flow for new application-level state.
- Do not introduce new RxJS-centered state management patterns when Signals or direct imperative flow are sufficient.
- When Angular framework APIs, existing dependencies, or interoperability boundaries already expose RxJS, it may be used at that boundary, but it should not become the default cross-module state model.

## Window Guidance

The folder `/Users/xiewendao/Documents/aily/aily-blockly-experimental/blockly 渐进式优化方案（多轮）/` should be treated as window guidance for the rewrite.

Its role is to provide staged guidance rather than hard implementation law:

- `README.md` defines the overall target shape: monorepo, clear package boundaries, typed RPC, shared schema, AI workflow decoupling, and gradual decomposition.
- `step-1-target-architecture-and-migration-principles.md` through `step-8-execution-roadmap-and-acceptance.md` define a recommended execution sequence covering architecture, monorepo packaging, AI runtime relocation, shared type systems, frontend shell modernization, giant-file decomposition, build-chain upgrades, and phased acceptance.
- The package direction in these documents is especially relevant to this rewrite: `packages/ui`, `packages/desktop`, `packages/erpc`, `packages/shared`, and `packages/core/*`.
- The guidance explicitly aligns with `polywise/packages` organizational ideas, so it should be read together with `/Users/xiewendao/Documents/Projects/polywise/`.
- The `polywise` precedent for data interaction is especially relevant here: `hono` for HTTP surfaces, `trpc` for typed RPC boundaries, and `erpc` for Electron IPC.

When this guidance conflicts with current compatibility constraints, preserve compatibility first and adapt the staged plan instead of forcing a disruptive migration. In particular, the guidance itself already emphasizes path compatibility, phased rollout, and gradual replacement over one-shot rewrites.
