# Refactor Baseline

This repository was reset on 2026-06-17 on branch `xwd-experimental` to start a full rewrite from a clean slate.

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
- Templates prefer Angular's modern control-flow syntax such as `@if`, `@for`, and `@switch`, with compact markup and inline bindings rather than excessive wrapper elements.
- SCSS is component-scoped, nested, and variable-driven, relying on CSS custom properties like `var(--aily-...)` instead of utility-class-heavy styling.
- Node-side helper scripts under `child/scripts/` are less consistent: they use CommonJS, 4-space indentation in places, and more manual formatting. These files should be treated as legacy exceptions rather than the new baseline.
- Naming is pragmatic rather than purist: service-heavy Angular code, `*.service.ts` modules, and descriptive component filenames dominate. There is also frequent use of `any` in UI code, which should not be carried forward as a preferred pattern.

## Rewrite Formatting Baseline

The rewrite should preserve the useful parts of the legacy style while making formatting deterministic.

- Keep 2-space indentation, single quotes, semicolons, and trailing commas as the default formatting baseline.
- Preserve Angular-oriented readability: concise decorators, explicit imports, and component-scoped SCSS.
- Normalize import ordering automatically instead of relying on manual grouping.
- Prefer ESM and typed TypeScript for new code unless a runtime constraint forces CommonJS.

## Prettier Baseline

- Root config files: `.prettierrc` and `.prettierignore`
- Imported precedent: `/Users/xiewendao/Documents/Projects/polywise/package.json`
- Plugin to adopt: `@ianvs/prettier-plugin-sort-imports`
- Deliberate non-goals: Tailwind-specific Prettier plugins and unrelated formatter plugins from `polywise`

The current Prettier setup intentionally uses the same file naming convention as `polywise`: `.prettierrc` and `.prettierignore`. Only `@ianvs/prettier-plugin-sort-imports` is retained from that precedent; Tailwind-specific and other unrelated formatter plugins are intentionally excluded.

## Window Guidance

The folder `/Users/xiewendao/Documents/aily/aily-blockly-experimental/blockly 渐进式优化方案（多轮）/` should be treated as window guidance for the rewrite.

Its role is to provide staged guidance rather than hard implementation law:

- `README.md` defines the overall target shape: monorepo, clear package boundaries, typed RPC, shared schema, AI workflow decoupling, and gradual decomposition.
- `step-1-target-architecture-and-migration-principles.md` through `step-8-execution-roadmap-and-acceptance.md` define a recommended execution sequence covering architecture, monorepo packaging, AI runtime relocation, shared type systems, frontend shell modernization, giant-file decomposition, build-chain upgrades, and phased acceptance.
- The package direction in these documents is especially relevant to this rewrite: `packages/ui`, `packages/desktop`, `packages/erpc`, `packages/shared`, and `packages/core/*`.
- The guidance explicitly aligns with `polywise/packages` organizational ideas, so it should be read together with `/Users/xiewendao/Documents/Projects/polywise/`.

When this guidance conflicts with current compatibility constraints, preserve compatibility first and adapt the staged plan instead of forcing a disruptive migration. In particular, the guidance itself already emphasizes path compatibility, phased rollout, and gradual replacement over one-shot rewrites.
