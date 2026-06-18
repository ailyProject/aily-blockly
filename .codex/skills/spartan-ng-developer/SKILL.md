---
name: spartan-ng-developer
description: Generates Spartan/ng UI code and guidance for Angular projects using @spartan-ng/helm (styled components copied into the repo) and @spartan-ng/brain (headless primitives). Covers installation, Tailwind theming (v3 and v4), component usage across all categories (forms, overlays, layout, display, data), Brain primitives, ReactiveForms / Signal Forms integration, and accessibility. Use when the user mentions Spartan, spartan-ng, @spartan-ng, hlm-* or brn-* components, OR when the Angular project's package.json contains @spartan-ng/* dependencies. Pairs with angular-developer for Angular fundamentals.
license: MIT
metadata:
  author: Mofiro Jean
  version: '0.0.1'
---

# Spartan/ng Developer Guidelines

> **Pairs with `angular-developer`** - that skill provides Angular fundamentals (signals, DI, routing, forms, SSR, accessibility). This skill focuses on Spartan/ng specifics. Install both for the best experience.

## Compatibility

- **Tracks:** `@spartan-ng/brain` v0.0.1-alpha.714 exactly. Spartan ships near-daily alpha patches, the skill is re-validated each time the tracked version is bumped.
- **Angular:** v18 or newer required. Standalone components, control flow (`@if` / `@for`), and signal-based APIs (`input()` / `output()`) are assumed. Will not generate `NgModule`-based or decorator-based code.
- **Tailwind:** v3 or v4. The skill detects the major version from `package.json` and adapts.
- **Not supported:** other Spartan alphas with API drift, Angular v17 or below, projects using `@spartan-ng/ui-*` packages (deprecated, replaced by `@spartan-ng/helm`).

If the project's installed version differs significantly from the tracked one, warn the user before generating code, the API surface may have shifted.

1. Always check the project's Spartan/ng version before providing guidance. Spartan is pre-1.0 and conventions evolve - `package.json` is the source of truth.

2. Detect the project layout up front:
   - If `nx.json` exists → Nx workspace. Use `npx nx g @spartan-ng/cli:ui <name>` commands.
   - Otherwise → Angular CLI. Use `ng g @spartan-ng/cli:ui <name>` commands.

   The destination path for generated Helm source is configured in `components.json` (`componentsPath`) - don't hard-code path assumptions. Find the actual location in `tsconfig.json` `paths` after `init`. See [setup.md](references/setup.md).

3. Detect the Tailwind major version in `package.json` (`tailwindcss` dependency). Spartan supports both v3 and v4 but the config syntax differs significantly. See [setup.md](references/setup.md).

4. After generating code that uses Spartan components, run `ng build` to verify there are no compilation errors. If components render unstyled, the issue is almost always Tailwind config - see the troubleshooting section in [setup.md](references/setup.md).

## Spartan architecture: Helm vs Brain (critical)

Spartan ships two packages with a unique relationship:

- **`@spartan-ng/helm`** - Styled components that live **in the user's project**, not in `node_modules`. The CLI (`ng g @spartan-ng/cli:ui button`) copies the component source into the path configured by `components.json` (`componentsPath`). The `@spartan-ng/helm/<name>` import is a tsconfig path alias to the generated source. To customize a Helm component, **edit the file in the user's repo**. Do not look for it in `node_modules`.

- **`@spartan-ng/brain`** - Headless, accessible primitives installed normally from npm. Helm components compose Brain primitives via Angular's `hostDirectives`.

**Default to Helm.** Reach for Brain only when: (1) Helm doesn't expose the primitive you need, (2) you're building a reusable composition that wraps multiple Helm components, or (3) you need to control accessibility attributes Helm hides.

## Installation and theming

- **Setup**: Install the CLI, add Spartan, configure Tailwind (v3 and v4 both supported), CLI vs Nx detection. Read [setup.md](references/setup.md)
- **Theming**: CSS variables, dark mode, custom themes. Read [theming.md](references/theming.md)

## Components

Spartan/ng provides 56 stable Helm components, grouped here by category. The shared conventions file applies to all of them; the category files cover specific component APIs and gotchas.

- **Helm conventions**: The `hlm*` directive pattern, signal inputs, composition via `hostDirectives`, the `cn()` helper, the `HlmXImports` barrel pattern, common pitfalls. Read [helm-conventions.md](references/helm-conventions.md)
- **Form controls**: Autocomplete, Button, Button Group, Checkbox, Combobox, Date Picker, Field, Input, Input Group, Input OTP, Label, Native Select, Radio Group, Select, Slider, Switch, Textarea, Toggle, Toggle Group. Read [form-controls.md](references/form-controls.md)
- **Overlays**: Alert Dialog, Command, Context Menu, Dialog, Dropdown Menu, Hover Card, Menubar, Navigation Menu, Popover, Sheet, Sonner (Toast), Tooltip. Read [overlays.md](references/overlays.md)
- **Layout**: Accordion, Aspect Ratio, Card, Collapsible, Resizable, Scroll Area, Separator, Sidebar, Tabs. Read [layout.md](references/layout.md)
- **Display**: Alert, Avatar, Badge, Empty, Icon, Item, Kbd, Progress, Skeleton, Spinner. Read [display.md](references/display.md)
- **Data display**: Breadcrumb, Calendar, Carousel, Data Table, Pagination, Table. Read [data-display.md](references/data-display.md)

## Brain primitives

- **Brain**: Headless primitives, when to drop down from Helm, building custom compositions. Read [brain.md](references/brain.md)

## Forms integration

- **Forms**: Wiring Helm form components to ReactiveForms or Signal Forms, `ControlValueAccessor` patterns, validation display. Read [forms.md](references/forms.md)

## Accessibility

- **Accessibility**: A11y conventions Helm and Brain provide for free, ARIA patterns to know, and gotchas. Read [accessibility.md](references/accessibility.md)
