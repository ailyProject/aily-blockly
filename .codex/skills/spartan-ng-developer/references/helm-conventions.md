# Helm Conventions

The shared patterns that apply to every Spartan/ng Helm component. Read this once - every category catalog ([form-controls.md](form-controls.md), [overlays.md](overlays.md), [layout.md](layout.md), [display.md](display.md), [data-display.md](data-display.md)) assumes you know these conventions and only documents per-component variation.

## 1. The `Hlm{X}Imports` barrel

Every Helm component module exports a barrel under the name `Hlm{ComponentName}Imports`. Add it to a standalone component's `imports` array - it pulls in every directive and sub-component the template needs.

```ts
import { HlmButtonImports } from '@spartan-ng/helm/button'
import { HlmDialogImports } from '@spartan-ng/helm/dialog'
import { HlmSelectImports } from '@spartan-ng/helm/select'

@Component({
	imports: [HlmButtonImports, HlmSelectImports, HlmDialogImports],
	template: `...`
})
export class Demo {}
```

The package path is always `@spartan-ng/helm/<kebab-case-name>`. Multi-word components: `dropdown-menu`, `data-table`, `input-otp`, `aspect-ratio`, `hover-card`, `navigation-menu`, etc.

> **Helm code lives in the user's repo.** When you see `@spartan-ng/helm/button`, that import is a tsconfig path alias to the generated Helm source the CLI copied into the project - **not** to `node_modules`. The exact location is configured by `components.json` (`componentsPath`); look up `tsconfig.json` `paths` to find where in your repo the source actually lives. To customize behavior or styling, edit those files.

## 2. Three template patterns

Helm components use one of three template patterns. Knowing which pattern a given component uses is the difference between code that compiles and code that doesn't.

### Pattern A - Directive on a native element

A simple directive applied to a native HTML element. Used by primitives like Button, Input, Label.

```html
<button hlmBtn variant="outline">Click me</button> <input hlmInput placeholder="Type here" />
```

The directive accepts inputs (`variant`, `size`, etc.) and binds host classes/attributes via Angular's host bindings.

### Pattern B - Compound component (multiple cooperating tags)

A set of parent/child tags that form a structure. Used by anything with composed parts - Select, Tabs, Dialog, Dropdown Menu, Card, Accordion, Sidebar, Data Table, Menubar, etc.

```html
<hlm-select [itemToString]="itemToString">
	<hlm-select-trigger class="w-56">
		<hlm-select-value placeholder="Pick a fruit" />
	</hlm-select-trigger>
	<hlm-select-content *hlmSelectPortal>
		<hlm-select-group>
			<hlm-select-label>Fruits</hlm-select-label>
			@for (item of items; track item.value) {
			<hlm-select-item [value]="item.value">{{ item.label }}</hlm-select-item>
			}
		</hlm-select-group>
	</hlm-select-content>
</hlm-select>
```

The container holds shared state; children are scoped to its context. All parts come from the same `Hlm{X}Imports` barrel.

### Pattern C - Structural directives for portaled content

Some overlays (Alert Dialog, Dialog, Hover Card, Popover, Sheet, Navigation Menu content) keep content as element children and project it into a CDK overlay via a structural directive `*hlm{X}Portal`:

```html
<hlm-dialog>
	<button hlmDialogTrigger hlmBtn>Open</button>
	<hlm-dialog-content *hlmDialogPortal="let ctx">
		<hlm-dialog-header>
			<h3 hlmDialogTitle>Title</h3>
			<p hlmDialogDescription>Description text</p>
		</hlm-dialog-header>
		<hlm-dialog-footer>
			<button hlmBtn (click)="ctx.close()">Cancel</button>
		</hlm-dialog-footer>
	</hlm-dialog-content>
</hlm-dialog>
```

Notes:

- `*hlmDialogPortal="let ctx"` is a structural directive (analogous to `*ngIf="x as y"`); `ctx` exposes dialog state.
- **Helm directives stack.** `<button hlmDialogTrigger hlmBtn>` applies both the Spartan trigger and the Helm button styling to one element.

### Pattern D - Trigger-with-template-ref (template-driven overlays)

Other overlays - **Context Menu, Dropdown Menu, Menubar** - wire the trigger to an `<ng-template>` reference rather than projecting child elements. The trigger directive takes the template as an input:

```html
<button hlmBtn [hlmDropdownMenuTrigger]="menu">Open</button>

<ng-template #menu>
	<hlm-dropdown-menu>
		<button hlmDropdownMenuItem>Profile</button>
		<hlm-dropdown-menu-separator />
		<button hlmDropdownMenuItem>Logout</button>
	</hlm-dropdown-menu>
</ng-template>
```

There is **no** `*hlm{X}Portal` directive for these - the trigger owns the overlay lifecycle. Items inside are usually `<button hlm{X}Item>` directives, not element children of a parent component.

**Tooltip** is yet another shape: a single attribute directive (`<button [hlmTooltip]="text">`) with no compound parts at all. See [overlays.md](overlays.md) per-component for the canonical example.

## 3. Signal inputs

All Helm component inputs use Angular's `input()` function (signal-based). The user reads them like signals inside the component:

```ts
variant = input<'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link'>('default')
size = input<'default' | 'xs' | 'sm' | 'lg' | 'icon'>('default')
```

Bindings from parent templates use bracket notation for dynamic values and bare attributes for static strings:

```html
<button hlmBtn variant="outline" [size]="currentSize()">Click</button>
```

When customizing or extending Helm components, stay consistent - use `input()`, not the legacy `@Input()` decorator.

## 4. `hostDirectives` composition with Brain

Helm doesn't reimplement behavior - it wraps Brain primitives. Angular's `hostDirectives` mechanism applies one or more directives to the host element of the wrapping component, so the Brain primitive's logic runs on the same element as Helm's styling.

Example - `HlmButton` wraps `BrnButton`:

```ts
@Directive({
	selector: 'button[hlmBtn], a[hlmBtn]',
	hostDirectives: [{ directive: BrnButton, inputs: ['disabled'] }]
	// ...host bindings for classes
})
export class HlmButton {}
```

What this means in practice:

- The user writes `<button hlmBtn disabled>`. Angular applies both `BrnButton` (manages disabled-state semantics, ARIA) and `HlmButton` (applies Tailwind classes) to the same `<button>` element.
- **Brain handles accessibility, focus, and state. Helm handles appearance.**
- Compound components compose multiple Brain primitives at once. `HlmSelect`'s host directives include `BrnSelect`, `BrnPopover`, plus several `BrnSelect*` sub-directives - the user typically doesn't need to know this; they just use the Helm tags.

When the user needs behavior Helm doesn't expose, drop down to Brain directly (see [brain.md](brain.md)).

## 5. Services for programmatic operations

A handful of components (notably Dialog) expose a service for opening/closing programmatically without a template trigger:

```ts
import { HlmDialogService } from '@spartan-ng/helm/dialog';

@Component({...})
export class Page {
  private readonly dialog = inject(HlmDialogService);

  openEditor() {
    const ref = this.dialog.open(EditorComponent, {
      contentClass: 'sm:!max-w-[750px]',
    });
    ref.closed$.subscribe(result => { /* handle close */ });
  }
}
```

Pattern:

- Inject the service via `inject(HlmXService)`.
- Call `.open(componentOrTemplate, options?)` to launch.
- The returned ref exposes `closed$` (an observable of the close result).

Services that exist are documented per-component in the category catalogs.

## 6. Styling on top of Helm

Helm components accept user classes via a `class` input or host-element classes, and merge them with the directive's own classes:

```html
<button hlmBtn class="w-full uppercase tracking-wider">Wide button</button>
```

Internally, the Helm directive uses a class-merging utility named `hlm()` (`twMerge(clsx(inputs))` under the hood) exported from `@spartan-ng/helm/utils`. The `@spartan-ng/helm/utils` package also exposes `classes()` for reactive class composition. Either lives in the Helm source the CLI generates into your project - check `tsconfig.json` `paths` for the actual location in your repo.

For **systemic** restyling, edit the generated Helm source files directly - they're in your repo at the location configured by `components.json` (see [setup.md](setup.md)).

## 7. Common pitfalls

| Pitfall                                                                                     | What goes wrong                                               | Fix                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Importing from `@spartan-ng/brain/<x>` when you wanted Helm                                 | Component renders unstyled                                    | Use `@spartan-ng/helm/<x>` for visible components                                                                                                                                                                           |
| Looking in `node_modules/@spartan-ng/helm` for source to customize                          | Folder is empty / barrel-only                                 | Source lives in your repo at the path set by `components.json` `componentsPath`; check `tsconfig.json` `paths`                                                                                                              |
| Forgetting to add the barrel to `imports`                                                   | Template error: unknown element/directive                     | Add `Hlm{X}Imports` to the standalone component's `imports` array                                                                                                                                                           |
| Using `@Input()` instead of `input()` when extending                                        | Type mismatches with signal-based bindings                    | Use signal inputs to stay consistent                                                                                                                                                                                        |
| Mixing Helm + raw Brain primitives without understanding `hostDirectives`                   | Duplicate-directive errors or doubled behavior                | Use Brain directly only when Helm doesn't expose what you need ([brain.md](brain.md))                                                                                                                                       |
| Replacing `@import "tailwindcss/theme.css" layer(theme); ...` with `@import "tailwindcss";` | Spartan preset layers incorrectly; components render unstyled | Keep the explicit four-line layer imports - see [setup.md](setup.md)                                                                                                                                                        |
| Forgetting `*hlmXPortal` on a Pattern-C overlay's content                                   | Overlay renders inline (broken layout / z-index)              | Add the structural directive: `<hlm-dialog-content *hlmDialogPortal>`. Pattern-D overlays (Dropdown Menu, Context Menu, Menubar) don't use `*hlmXPortal` - they take a template ref via `[hlm{X}Trigger]="tplRef"` instead. |

## See also

- [Back to SKILL.md](../SKILL.md)
- [Brain primitives](brain.md) - what Helm composes underneath; when to drop down.
- Category catalogs: [form-controls.md](form-controls.md) · [overlays.md](overlays.md) · [layout.md](layout.md) · [display.md](display.md) · [data-display.md](data-display.md)
- [Forms integration](forms.md) - how Helm form components plug into ReactiveForms / Signal Forms.
