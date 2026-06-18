# Brain Primitives

`@spartan-ng/brain` is Spartan's package of **headless, accessible primitives**. Helm composes them via `hostDirectives` (see [helm-conventions.md](helm-conventions.md) §4). For most work, use Helm. Drop down to Brain only when the section below describes your case.

## 1. When to use Brain directly

Use **Helm** by default. Reach for Brain only when:

1. **The primitive you need has no Helm equivalent.** Rare, but happens at the edge of the library (e.g. a custom Popover trigger that isn't a button at all).
2. **You're building a reusable composition that wraps multiple Helm components** and need lower-level control of state/events between them.
3. **You need to control ARIA attributes that Helm hides.** Edge cases around custom labels, live regions, or non-standard roles.
4. **You're authoring a new Helm-style directive in the user's repo** to fill a gap in the catalog - that new directive will host-directive a Brain primitive itself.

If your case isn't one of these, don't introduce Brain into a feature component - it adds API surface without adding capability.

## 2. Brain module catalog

Brain modules are organized by component, mirroring Helm's package paths. Imports look like:

```ts
import { BrnButton } from '@spartan-ng/brain/button'
import { BrnDialog, BrnDialogContent, BrnDialogTrigger } from '@spartan-ng/brain/dialog'
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover'
import { BrnSelect, BrnSelectContent, BrnSelectTrigger } from '@spartan-ng/brain/select'
import { BrnTooltip, BrnTooltipContent, BrnTooltipTrigger } from '@spartan-ng/brain/tooltip'
```

Available modules (one per Helm component category - Brain doesn't ship a visible-component catalog of its own):

`accordion`, `alert-dialog`, `autocomplete`, `avatar`, `button`, `calendar`, `checkbox`, `collapsible`, `combobox`, `command`, `core`, `date-time`, `date-time-luxon`, `dialog`, `field`, `forms`, `hover-card`, `input`, `input-otp`, `label`, `navigation-menu`, `popover`, `progress`, `radio-group`, `resizable`, `select`, `separator`, `sheet`, `slider`, `sonner`, `switch`, `tabs`, `textarea`, `toggle`, `toggle-group`, `tooltip`

**Not every Helm component has a Brain primitive.** Helm-only components - Aspect Ratio, Carousel, Context Menu, Data Table, Date Picker, Dropdown Menu, Icon, Input Group, Menubar, Scroll Area, Sidebar, Table - compose their behaviour from other Brain primitives (e.g. Dialog, Popover, Dropdown Menu via `brain/dialog`, `brain/popover`) or from external libraries (Embla for carousel, ngx-scrollbar for scroll-area, TanStack Table for data-table, `@ng-icons` for icon). Verify the exact set by listing `node_modules/@spartan-ng/brain/` in your project - the canonical list at time of writing comes from [the `libs/brain/` tree in the upstream repo](https://github.com/spartan-ng/spartan/tree/main/libs/brain).

> **Verify import paths against the installed `@spartan-ng/brain` version.** Brain's surface is large and exact directive names occasionally change between minor versions. If a directive isn't found, check the package's `dist/` index or its source on GitHub.

## 3. Custom composition example

Building a custom "tag input" by composing Brain primitives:

```ts
import { Component, computed, signal } from '@angular/core'
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover'
import { HlmButtonImports } from '@spartan-ng/helm/button'
import { HlmInputImports } from '@spartan-ng/helm/input'

@Component({
	selector: 'app-tag-input',
	imports: [BrnPopover, BrnPopoverTrigger, BrnPopoverContent, HlmButtonImports, HlmInputImports],
	template: `
		<brn-popover>
			<button brnPopoverTrigger hlmBtn variant="outline">{{ tags().length }} tags</button>
			<ng-template brnPopoverContent>
				<div class="rounded-md border bg-popover p-2 shadow-md">
					<input hlmInput (keydown.enter)="addTag($event)" placeholder="Add tag" />
					<ul>
						@for (t of tags(); track t) {
							<li>{{ t }} <button (click)="removeTag(t)">×</button></li>
						}
					</ul>
				</div>
			</ng-template>
		</brn-popover>
	`
})
export class TagInput {
	tags = signal<string[]>([])
	addTag(e: Event) {
		/* ... */
	}
	removeTag(t: string) {
		/* ... */
	}
}
```

Notes on this pattern:

- Brain's popover uses an `<ng-template>` with a structural-style binding (`brnPopoverContent`) - the body is rendered into a portal on open. Helm wraps this with its own `*hlmPopoverPortal` for nicer ergonomics.
- The custom content uses Helm styling primitives (`bg-popover`, `rounded-md`, etc.) on top of Brain's positioning.

For a _new reusable_ component like this, the convention is to add it to the user's UI library (`src/libs/ui/ui-tag-input-helm/`) so it sits alongside the generated Helm components.

## 4. Controllers and content children

Several Brain primitives use Angular's **content children** mechanism to coordinate between a parent and its children. The parent directive collects content children via `contentChildren()` and applies cross-cutting logic.

Examples:

- `BrnSelect` queries its `<brn-select-item>` children to track which is highlighted.
- `BrnTabs` queries `<brn-tabs-trigger>` and `<brn-tabs-content>` and links them by `value`.
- `BrnRadioGroup` queries `<brn-radio-group-item>` and manages keyboard navigation across them.

When composing Brain manually, the children must be inside the same `<brn-X>` element to be discovered. Placing a child outside the parent (e.g. via portal) breaks the query - use the parent directive's API (services, signals) to coordinate from afar in that case.

## 5. ARIA hooks

When you need to override ARIA attributes Helm normally manages, Brain primitives expose inputs for the underlying attributes:

```html
<button brnDialogTrigger aria-label="Open settings" [attr.aria-describedby]="hintId">⚙</button>
```

For attributes Brain manages internally (`aria-expanded`, `aria-haspopup`, etc.), let Brain own them - overriding causes inconsistency with the actual component state.

## 6. Configuration via provideBrn\* functions

Brain ships configuration tokens for global behavior:

```ts
// app.config.ts
import { provideBrnDialogDefaultOptions, provideBrnPopoverConfig } from '@spartan-ng/brain/popover'

bootstrapApplication(App, {
	providers: [
		provideBrnPopoverConfig({ align: 'start', sideOffset: 8 }),
		provideBrnDialogDefaultOptions({ autoFocus: 'first-heading' })
	]
})
```

These set defaults for every popover/dialog in the app. Helm components inherit them.

## 7. Common gotchas

| Pitfall                                                     | What goes wrong                              | Fix                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Importing Brain when Helm exists                            | Unstyled output                              | Use Helm unless one of the cases in §1 applies                                                    |
| Mixing Brain and Helm directives on the same element        | Duplicate-directive errors, doubled behavior | Helm already host-directives Brain; pick one layer per element                                    |
| Forgetting `<ng-template>` wrapper for Brain content        | Content renders inline instead of portaled   | Brain content patterns often need `<ng-template>`; check the directive's expected projection type |
| Querying Brain content children from outside the Brain root | `contentChildren()` returns empty            | Children must be nested inside the parent `<brn-X>` element                                       |
| Overriding `aria-expanded` / `aria-haspopup` manually       | Conflicts with Brain's state-tracking        | Let Brain own these; only override descriptive attributes like `aria-label`                       |

## See also

- [Helm conventions](helm-conventions.md) - Helm composes Brain via `hostDirectives`.
- [Form controls](form-controls.md), [Overlays](overlays.md), etc. - each entry notes which Brain primitives Helm composes underneath.
- [Accessibility](accessibility.md) - Brain owns most ARIA; your job is the rest.
- [Back to SKILL.md](../SKILL.md)
