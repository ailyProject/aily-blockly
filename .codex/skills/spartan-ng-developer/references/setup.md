# Setup

Install Spartan/ng into an Angular project. Follow the steps in order: detect the project layout, detect the Tailwind version, run Spartan's `init` schematic, run `ui-theme` to seed the theme variables, then generate Helm components as needed.

> ⚠ **For AI agents / CI / automation:** the `init` and `ui-theme` schematics are **fully interactive** (they prompt via `enquirer` and ignore `--defaults` / `--interactive=false` because their `schema.json` files have empty `properties`). If you don't have a TTY, follow §"Non-interactive install" below instead of the interactive `init` flow.

## Step 1 - Detect project layout

Read the project root:

- **`nx.json` exists** → Nx workspace. Use `npx nx g` to run schematics.
- **No `nx.json`** → Angular CLI project. Use `ng g` to run schematics.

The same Spartan package (`@spartan-ng/cli`) serves both runners. There is no separate `cli-nx` package.

The destination directory for generated Helm source is configured by `components.json` (`componentsPath`) - see §"components.json" below. Don't hard-code path assumptions; check `tsconfig.json` `paths` after `init` to find where the CLI actually placed things.

## Step 2 - Detect Tailwind version

Read `package.json` `dependencies` / `devDependencies` and inspect the `tailwindcss` major version:

- **v4** → Spartan's only documented installation path. Uses CSS-side configuration (`@theme` directive, layer imports).
- **v3** → **Compatibility is not guaranteed.** Spartan's docs explicitly say "some components may not work as expected" on v3 and "strongly recommend upgrading to Tailwind v4". The v3 config in Step 6 is preserved here from earlier Spartan releases for legacy projects only.
- **Tailwind not installed yet** → install it first using Tailwind's official docs. **Always pick v4** for new Spartan projects.

Match the rest of this guide to the detected version.

## Step 3 - Install Spartan

Use the project's package manager (npm / pnpm / yarn - check the lockfile).

### Angular CLI

```sh
npm install -D @spartan-ng/cli
ng g @spartan-ng/cli:init
```

### Nx

```sh
npm install -D @spartan-ng/cli
npx nx g @spartan-ng/cli:init
```

The `init` schematic:

- Installs `@spartan-ng/brain` (the headless primitives package) and `@angular/cdk` (overlay / portal services).
- Writes `components.json` at the repo root with default `componentsPath` and `importAlias` (see §"components.json" below).
- Sets up the Tailwind preset import in your global stylesheet.

**It does not seed the CSS variable theme block.** Run the separate `ui-theme` schematic for that - see Step 5.

If the schematic prompts for a Tailwind version, answer based on Step 2.

## Step 4 - Tailwind v4 setup (recommended)

If `init` didn't already write these, ensure your global stylesheet (typically `src/styles.css`) contains the layered imports plus the Spartan preset:

```css
@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/preflight.css' layer(base);
@import 'tailwindcss/utilities.css';
@import '@spartan-ng/brain/hlm-tailwind-preset.css';
```

Then add the CSS variable theme block (see [theming.md](theming.md) for the full `:root` + `.dark` definition).

> **Don't simplify the layer imports.** The instinct is to replace all four with `@import "tailwindcss";` - but Spartan's preset relies on the explicit layer ordering to layer correctly. Keep all four lines.

## Step 5 - Generate the theme

Run `ui-theme` to write the `:root` + `.dark` CSS variable block into your global stylesheet:

```sh
# Angular CLI
ng g @spartan-ng/cli:ui-theme

# Nx
npx nx g @spartan-ng/cli:ui-theme
```

The schematic prompts for application (in multi-project workspaces), styles entry point, theme choice, and border-radius. See [theming.md](theming.md) for the canonical variable values and dark-mode wiring.

> ⚠ Re-running `ui-theme` replaces the existing theme block - back up any custom additions first.

## Step 6 - Tailwind v3 setup (legacy, not officially supported)

> ⚠ **Spartan's current docs explicitly recommend upgrading to v4.** From upstream: _"some components may not work as expected"_ on v3, and the team _"strongly recommends"_ the upgrade. Only follow this section if you're maintaining an existing v3 project that can't migrate yet. Verify everything against your installed CLI version before relying on it.

For projects on Tailwind v3, write the config and styles manually.

**`tailwind.config.js` - Angular CLI:**

```js
module.exports = {
	presets: [require('@spartan-ng/brain/hlm-tailwind-preset')],
	content: ['./src/**/*.{html,ts}', './REPLACE_WITH_PATH_TO_YOUR_COMPONENTS_DIRECTORY/**/*.{html,ts}'],
	theme: { extend: {} },
	plugins: []
}
```

**`tailwind.config.js` - Nx:**

```js
const { createGlobPatternsForDependencies } = require('@nx/angular/tailwind')
const { join } = require('path')

module.exports = {
	presets: [require('@spartan-ng/brain/hlm-tailwind-preset')],
	content: [join(__dirname, 'src/**/!(*.stories|*.spec).{ts,html}'), ...createGlobPatternsForDependencies(__dirname)],
	theme: { extend: {} },
	plugins: []
}
```

**`src/styles.css` (v3 only)** must explicitly import the CDK overlay styles - they're auto-included by the Spartan preset in v4 but not in v3:

```css
@import '@angular/cdk/overlay-prebuilt.css';
```

Then add the CSS variable theme block - see [theming.md](theming.md).

## Non-interactive install (for AI agents and CI)

`init` and `ui-theme` cannot be run non-interactively — their `schema.json` files have empty `properties: {}` and the prompts live inside the generator code via `enquirer.prompt()` calls. **No flag will suppress them.** Verified by reading `node_modules/@spartan-ng/cli/src/generators/{init,theme}/generator.js`.

For automated environments, replicate what `init` + `ui-theme` would do, then continue with the regular `ng g @spartan-ng/cli:ui <name>` flow (which _does_ accept flags). Exact steps:

**A. Install the dependencies `init` would add** (versions inferred from `src/generators/base/versions.js` and `build-dependency-array.js`):

```sh
npm install -D @spartan-ng/cli
# Runtime deps init adds
npm install @spartan-ng/brain @angular/cdk tailwind-merge
# Only needed if you later generate icon or spinner (init adds them lazily)
npm install @ng-icons/core @ng-icons/lucide
# Tailwind v4 dev dep init adds
npm install -D tw-animate-css
```

Match the version of `@spartan-ng/brain` to your installed `@spartan-ng/cli`. CDK should match your Angular major version.

**B. Write the styles entry point yourself.** The exact template the `ui-theme` generator writes for Tailwind v4 + the Neutral theme is:

```css
@layer theme, base, components, utilities;
@import 'tailwindcss/theme.css' layer(theme);
@import 'tailwindcss/preflight.css' layer(base);
@import 'tailwindcss/utilities.css';
@import '@spartan-ng/brain/hlm-tailwind-preset.css';

:root {
	color-scheme: light;
	--font-sans:
		-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif,
		'Apple Color Emoji', 'Segoe UI Emoji', 'Segoe UI Symbol', 'Noto Color Emoji';
	/* full :root variable block — see theming.md */
}

:root.dark {
	color-scheme: dark;
	/* full :root.dark variable block — see theming.md */
}

@layer base {
	* {
		@apply border-border outline-ring/50;
	}
	body {
		@apply bg-background text-foreground;
	}
}
```

If `ng add tailwindcss` wrote a bare `@import 'tailwindcss';`, **remove** that line — the four explicit layer imports above replace it.

The Neutral block is in [theming.md](theming.md). For other base themes (Stone, Zinc, Gray, Slate), pull values from `node_modules/@spartan-ng/cli/src/generators/theme/libs/colors.js` `exports.themes`.

**C. Create `components.json` at the repo root.** `init` writes this; if it didn't run, write it yourself with the path you want. See https://spartan.ng/documentation/components-json.

After A + B + C, the rest (`ng g @spartan-ng/cli:ui <name>`) works non-interactively when you supply the component name as a positional arg.

## Step 7 - Generate Helm components

Two patterns:

**Interactive picker** (lists all components, user selects):

```sh
# Angular CLI
ng g @spartan-ng/cli:ui

# Nx
npx nx g @spartan-ng/cli:ui
```

**Direct generation** (component name as positional argument):

```sh
# Angular CLI
ng g @spartan-ng/cli:ui button
ng g @spartan-ng/cli:ui dialog

# Nx
npx nx g @spartan-ng/cli:ui button
```

The component name is the kebab-case form of any component listed at [spartan.ng/components](https://spartan.ng/components) - e.g. `button`, `dialog`, `dropdown-menu`, `data-table`.

The schematic copies the Helm component source into the project at the path set by `components.json` `componentsPath`. The actual destination shows up in `tsconfig.json` `paths` after generation.

## Step 8 - components.json

`init` creates a `components.json` file at the repo root. It configures how the CLI generates code:

- **`componentsPath`** - base path for generated Helm libraries (e.g. `libs/ui`).
- **`importAlias`** - TypeScript path alias prefix the CLI registers (e.g. `@spartan-ng/helm` mapped to `componentsPath`).
- **Nx only - `buildable`** - generate the Helm libraries as buildable Nx libs.
- **Nx only - `generateAs`** - generate as `lib` or another Nx project kind.

See the canonical docs at [spartan.ng/documentation/components-json](https://spartan.ng/documentation/components-json) for the full schema and examples.

To change destination after `init`, edit `components.json` and re-run `ng g @spartan-ng/cli:ui <name>` - the new path is used for future generations (existing components stay where they were).

## Step 9 - Verify

After `init`, `ui-theme`, and at least one generated component:

1. Open the generated Helm folder - find its actual path in `tsconfig.json` `paths` (the `@spartan-ng/helm/<name>` alias). The component source files are now part of your repo, not in `node_modules`.
2. Import the barrel into a feature component:

   ```ts
   import { HlmButtonImports } from '@spartan-ng/helm/button'

   @Component({
   	imports: [HlmButtonImports],
   	template: `<button hlmBtn>Hello Spartan</button>`
   })
   export class Demo {}
   ```

3. Run the build: `ng build` (CLI) or `npx nx build <project>` (Nx). No errors expected.
4. Run the dev server and confirm the button renders styled. If it renders unstyled, see Troubleshooting.

## Troubleshooting

| Symptom                                                                                                                                                            | Likely cause                                                                                                                                                              | Fix                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component renders unstyled                                                                                                                                         | Tailwind config missing Spartan preset, OR global stylesheet missing theme variables                                                                                      | Re-check Step 4 (v4) or Step 5 (v3). Both the preset import AND the `:root` variable block must be present.                                                                                                                            |
| Build fails: `Cannot find module '@spartan-ng/helm/...'`                                                                                                           | Component wasn't generated, or import path is stale                                                                                                                       | Run `ng g @spartan-ng/cli:ui <name>` to regenerate.                                                                                                                                                                                    |
| Build fails: peer-dependency mismatch                                                                                                                              | Angular major version doesn't match Spartan's supported range                                                                                                             | Check the canonical version-support matrix at [spartan.ng/documentation/version-support](https://spartan.ng/documentation/version-support).                                                                                            |
| Dark mode doesn't trigger                                                                                                                                          | `.dark` class isn't being applied to `<html>` or `<body>`                                                                                                                 | Add a theme service that toggles the class; see [theming.md](theming.md).                                                                                                                                                              |
| "Where is the Helm component source?"                                                                                                                              | Confusion about Helm's copy-into-repo model                                                                                                                               | Find the path in `tsconfig.json` `paths` - the `@spartan-ng/helm/<name>` alias points at it. Configured by `components.json` `componentsPath`. Helm components are **not** in `node_modules`.                                          |
| Imports use a path that doesn't exist                                                                                                                              | Generated tsconfig path alias is missing                                                                                                                                  | Check `tsconfig.json` `paths` - the `init` schematic should have added `@spartan-ng/helm/*` aliases pointing to the generated UI library folder.                                                                                       |
| `NG3004: Unable to import component X. The module '@spartan-ng/helm/<name>' could not be found.` after generating a new Helm component while `ng serve` is running | esbuild/Vite cached the `tsconfig.json` `paths` at dev-server start; new aliases added by `ng g @spartan-ng/cli:ui <name>` are not picked up on hot reload                | **Stop and restart `ng serve`.** A fresh server reads the updated `tsconfig.json`. Verify the alias exists first: `grep "@spartan-ng/helm/<name>" tsconfig.json`.                                                                      |
| `NG0309: Directive _BrnButton matches multiple times on the same element`                                                                                          | Stacking two directives that both host-directive `HlmButton` (e.g. `<button hlmSidebarTrigger hlmBtn>`) — both bring `BrnButton`, which Angular forbids twice on one host | Use the more specific trigger directive on its own. `hlmSidebarTrigger` is a self-contained component (own template, own styling) — drop `hlmBtn`. The same applies to any future Helm directive that internally composes `HlmButton`. |

## See also

- [Back to SKILL.md](../SKILL.md)
- [Theming](theming.md) - fill in the CSS variable block and configure dark mode.
- [Helm conventions](helm-conventions.md) - once setup is done, learn the shared Helm patterns.
