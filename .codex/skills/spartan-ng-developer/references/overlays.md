# Overlays

The 12 Helm components that render above page content - dialogs, popovers, menus, toasts. All follow [helm-conventions.md](helm-conventions.md). Overlays do **not** share a single template shape - verify per component.

Three template families show up here:

- **Compound + portal** - content lives inside the parent component and a structural directive `*hlm{X}Portal` projects it into a CDK overlay. Used by Alert Dialog, Dialog, Hover Card, Popover, Sheet, Navigation Menu (content panel).
- **Trigger-with-template-ref** - the trigger element binds `[hlm{X}Trigger]="tplRef"` pointing at an `<ng-template>` that holds the menu. Used by Context Menu, Dropdown Menu, Menubar.
- **Attribute directive only** - no portal directive, no template ref; the directive itself owns the overlay. Used by Tooltip.

Sonner is the outlier - no per-instance template at all. Mount `<hlm-toaster />` once and call `toast(...)` from code.

For accessibility (focus trap, escape, ARIA), see [accessibility.md](accessibility.md).

---

### Alert Dialog

- **Pattern**: compound + portal
- **Import**: `HlmAlertDialogImports` from `@spartan-ng/helm/alert-dialog`
- **Use**: Confirmation modal for destructive or important actions. Blocks the page until the user acts.
- **Example**:
  ```html
  <hlm-alert-dialog>
  	<button hlmAlertDialogTrigger hlmBtn variant="outline">Show Dialog</button>
  	<hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx">
  		<hlm-alert-dialog-header>
  			<h2 hlmAlertDialogTitle>Are you absolutely sure?</h2>
  			<p hlmAlertDialogDescription>This action cannot be undone.</p>
  		</hlm-alert-dialog-header>
  		<hlm-alert-dialog-footer>
  			<button hlmBtn variant="outline" (click)="ctx.close()">Cancel</button>
  			<button hlmBtn (click)="ctx.close()">Continue</button>
  		</hlm-alert-dialog-footer>
  	</hlm-alert-dialog-content>
  </hlm-alert-dialog>
  ```
- **Gotcha**: The docs page does not explicitly document Escape/backdrop behavior. By the WAI-ARIA Alert Dialog pattern Brain follows, the user is expected to use the action/cancel buttons. Confirm against your installed version if you depend on this.

### Command

- **Pattern**: compound (often wrapped in a Dialog or Popover for the launcher)
- **Import**: `HlmCommandImports` from `@spartan-ng/helm/command`
- **Use**: Command palette / global search (Cmd+K menu).
- **Example**:
  ```html
  <hlm-command>
  	<hlm-command-input placeholder="Type a command or search..." />
  	<hlm-command-list>
  		<ng-template hlmCommandEmpty>No results found.</ng-template>
  		<hlm-command-group>
  			<hlm-command-group-label>Suggestions</hlm-command-group-label>
  			<button hlm-command-item value="profile">
  				Profile
  				<hlm-command-shortcut>⌘P</hlm-command-shortcut>
  			</button>
  			<button hlm-command-item value="settings">Settings</button>
  		</hlm-command-group>
  		<hlm-command-separator />
  	</hlm-command-list>
  </hlm-command>
  ```
- **Related**: `<hlm-command-dialog>` wraps Command inside a Dialog for a global Cmd+K launcher.
- **Gotcha**: Items are `<button hlm-command-item>` (directive on a button), not `<hlm-command-item>` element children. Built-in filtering matches on `value` and item text; override via the `filter` input on `<hlm-command>`.

### Context Menu

- **Pattern**: trigger-with-template-ref
- **Imports**: `HlmContextMenuImports` from `@spartan-ng/helm/context-menu` plus `HlmDropdownMenuImports` from `@spartan-ng/helm/dropdown-menu`
- **Use**: Right-click menu on an element.
- **Example**:

  ```html
  <div [hlmContextMenuTrigger]="menu" class="rounded border p-8">Right-click here</div>

  <ng-template #menu>
  	<hlm-dropdown-menu>
  		<hlm-dropdown-menu-group>
  			<button hlmDropdownMenuItem>Copy</button>
  			<button hlmDropdownMenuItem>Paste</button>
  			<hlm-dropdown-menu-separator />
  			<button hlmDropdownMenuItem>Delete</button>
  		</hlm-dropdown-menu-group>
  	</hlm-dropdown-menu>
  </ng-template>
  ```

- **Inputs on `[hlmContextMenuTrigger]`**: `disabled` (boolean), `align` (`'start' | 'end' | 'center'`), `side` (`'top' | 'bottom' | 'left' | 'right'`).
- **Outputs**: `hlmContextMenuOpened`, `hlmContextMenuClosed`.
- **Gotcha**: There are **no** `hlm-context-menu-*` content tags - the menu is always a `<hlm-dropdown-menu>` inside the template. Built on Angular CDK's `CdkContextMenuTrigger`. Mobile users can't right-click - provide an alternative trigger (long-press, three-dot button).

### Dialog

- **Pattern**: compound + portal (declarative) or programmatic via service
- **Imports**: `HlmDialogImports`, `HlmDialogService` from `@spartan-ng/helm/dialog`
- **Use**: Modal dialog. Opens declaratively (template) or programmatically (service).
- **Declarative example**:
  ```html
  <hlm-dialog>
  	<button hlmDialogTrigger hlmBtn>Edit profile</button>
  	<hlm-dialog-content *hlmDialogPortal="let ctx">
  		<hlm-dialog-header>
  			<h3 hlmDialogTitle>Edit profile</h3>
  			<p hlmDialogDescription>Make changes to your profile here.</p>
  		</hlm-dialog-header>
  		<!-- body -->
  		<hlm-dialog-footer>
  			<button hlmBtn (click)="ctx.close()">Save changes</button>
  		</hlm-dialog-footer>
  	</hlm-dialog-content>
  </hlm-dialog>
  ```
- **Programmatic example**:

  ```ts
  private readonly dialog = inject(HlmDialogService);

  openEditor() {
    const ref = this.dialog.open(EditorComponent, {
      contentClass: 'sm:!max-w-[750px]',
      context: { userId: 42 },
    });
    ref.closed$.subscribe(result => { /* handle */ });
  }
  ```

- **Common options**: `contentClass`, `backdropClass`, `closeOnBackdropClick`, `closeOnOutsidePointerEvents`, `closeDelay`, `disableClose`, `autoFocus`, `restoreFocus`, `showCloseButton`, `context`, `role`. Verify the full surface in `BrnDialogOptions` (`@spartan-ng/brain/dialog`) for your installed version.
- **Gotcha**: To block both Escape and backdrop dismissal, use `disableClose: true`. `closeOnBackdropClick: false` only blocks backdrop clicks.

### Dropdown Menu

- **Pattern**: trigger-with-template-ref
- **Import**: `HlmDropdownMenuImports` from `@spartan-ng/helm/dropdown-menu`
- **Use**: Click-triggered menu of actions.
- **Example**:

  ```html
  <button hlmBtn variant="outline" [hlmDropdownMenuTrigger]="menu">Open</button>

  <ng-template #menu>
  	<hlm-dropdown-menu class="w-56">
  		<hlm-dropdown-menu-label>My Account</hlm-dropdown-menu-label>
  		<hlm-dropdown-menu-separator />
  		<hlm-dropdown-menu-group>
  			<button hlmDropdownMenuItem>
  				<span>Profile</span>
  				<hlm-dropdown-menu-shortcut>⇧⌘P</hlm-dropdown-menu-shortcut>
  			</button>
  			<button hlmDropdownMenuItem>Settings</button>
  		</hlm-dropdown-menu-group>
  	</hlm-dropdown-menu>
  </ng-template>
  ```

- **Item directives**: `hlmDropdownMenuItem` (also exposed as `<hlm-dropdown-menu-item>`), `hlmDropdownMenuCheckbox`, `hlmDropdownMenuRadio`.
- **Sub-menus**: nest a `<hlm-dropdown-menu-sub>` and reference it via another `[hlmDropdownMenuTrigger]` on a parent item.
- **Gotcha**: Items are `<button hlmDropdownMenuItem>` directives, not `<hlm-dropdown-menu-item>` declared as element children. The menu always lives inside the `<ng-template>` referenced by the trigger.

### Hover Card

- **Pattern**: compound + portal (opens on hover with delay)
- **Import**: `HlmHoverCardImports` from `@spartan-ng/helm/hover-card`
- **Use**: Rich tooltip with formatted content. Use Tooltip for plain text.
- **Example**:
  ```html
  <hlm-hover-card>
  	<a hlmHoverCardTrigger href="/user/jean">@jean</a>
  	<hlm-hover-card-content *hlmHoverCardPortal>
  		<h4>Jean</h4>
  		<p>Joined May 2026</p>
  	</hlm-hover-card-content>
  </hlm-hover-card>
  ```
- **Common inputs**: `showDelay`, `hideDelay`, `animationDelay`, `sideOffset`, `align`. Triggers from a non-sibling element via `[hlmHoverCardTriggerFor]`.
- **Gotcha**: Hover-card is desktop-only by design - touch devices have no hover. Provide an alternative discovery path on mobile.

### Menubar

- **Pattern**: trigger-with-template-ref (one template per top-level menu)
- **Imports**: `HlmMenubarImports` from `@spartan-ng/helm/menubar` plus `HlmDropdownMenuImports`
- **Use**: Application-style horizontal menu bar (File, Edit, View, ...).
- **Example**:

  ```html
  <hlm-menubar>
  	<button [hlmMenubarTrigger]="file">File</button>
  	<button [hlmMenubarTrigger]="edit">Edit</button>
  </hlm-menubar>

  <ng-template #file>
  	<hlm-dropdown-menu sideOffset="1.5">
  		<button hlmDropdownMenuItem>New Tab</button>
  		<hlm-dropdown-menu-separator />
  		<button hlmDropdownMenuItem>Print</button>
  	</hlm-dropdown-menu>
  </ng-template>
  ```

- **Gotcha**: There are no `hlm-menubar-item` / `hlm-menubar-content` tags. Each menu's content is a `<hlm-dropdown-menu>` inside an `<ng-template>` referenced from the trigger button.

### Navigation Menu

- **Pattern**: attribute directives on semantic nav elements + content portal
- **Import**: `HlmNavigationMenuImports` from `@spartan-ng/helm/navigation-menu`
- **Use**: Site/app primary navigation with mega-menu-style flyout panels.
- **Example**:
  ```html
  <nav hlmNavigationMenu>
  	<ul hlmNavigationMenuList>
  		<li hlmNavigationMenuItem>
  			<button hlmNavigationMenuTrigger>Products</button>
  			<hlm-navigation-menu-content *hlmNavigationMenuPortal>
  				<a routerLink="/products/a">Product A</a>
  				<a routerLink="/products/b">Product B</a>
  			</hlm-navigation-menu-content>
  		</li>
  	</ul>
  </nav>
  ```
- **Gotcha**: Use Angular Router's `routerLink` for actual navigation - Spartan only renders the menu chrome.

### Popover

- **Pattern**: compound + portal
- **Import**: `HlmPopoverImports` from `@spartan-ng/helm/popover`
- **Use**: Floating panel anchored to a trigger. Less structured than Dialog - no header/footer convention.
- **Example**:
  ```html
  <hlm-popover>
  	<button hlmPopoverTrigger hlmBtn variant="outline">Open</button>
  	<hlm-popover-content *hlmPopoverPortal="let ctx" sideOffset="5">
  		<p class="text-sm">Arbitrary content here.</p>
  	</hlm-popover-content>
  </hlm-popover>
  ```
- **Positioning inputs**: `align`, `sideOffset`, `offsetX` (on `<hlm-popover-content>`).
- **Gotcha**: For form-like floating panels (date pickers, color pickers) use Popover. For confirmation-style modals use Dialog.

### Sheet

- **Pattern**: compound + portal (slide-in panel)
- **Import**: `HlmSheetImports` from `@spartan-ng/helm/sheet`
- **Use**: Side-mounted panel (drawer). Replaces Dialog when you want an edge-attached panel.
- **Example**:
  ```html
  <hlm-sheet>
  	<button hlmSheetTrigger hlmBtn variant="outline">Open</button>
  	<hlm-sheet-content *hlmSheetPortal>
  		<hlm-sheet-header>
  			<h3 hlmSheetTitle>Edit profile</h3>
  			<p hlmSheetDescription>Make changes here.</p>
  		</hlm-sheet-header>
  		<!-- body -->
  	</hlm-sheet-content>
  </hlm-sheet>
  ```
- **Other selectors**: `[hlmSheetOverlay]`, `[hlmSheetDescription]`, `<hlm-sheet-footer>`.
- **Gotcha**: There is no `HlmSheetService` - use `HlmDialogService` if you need to open programmatically. On mobile, design for `100dvh` not `100vh`.

### Sonner (Toast)

- **Pattern**: programmatic (no per-instance template)
- **Imports**:
  - Root component (`<hlm-toaster />`): `HlmToasterImports` from `@spartan-ng/helm/sonner`
  - `toast` API: from `@spartan-ng/brain/sonner` - **not** the helm package
- **Setup**: mount `<hlm-toaster />` once at the app root.
- **Trigger**:

  ```ts
  import { toast } from '@spartan-ng/brain/sonner';

  showToast() {
    toast('Event has been created', {
      description: 'Sunday, December 03 at 9:00 AM',
      action: { label: 'Undo', onClick: () => undo() },
      position: 'bottom-right',
      duration: 4000,
    });
  }
  ```

- **Methods**: `toast()`, `toast.success()`, `toast.error()`, `toast.warning()`, `toast.info()`, `toast.promise(promise, { loading, success, error })`.
- **Gotcha**: The `toast` function is exported from `@spartan-ng/brain/sonner`. The root component comes from the helm package. Two different imports - easy to get wrong.

### Tooltip

- **Pattern**: attribute directive only - no template, no portal directive on your side
- **Import**: `HlmTooltipImports` from `@spartan-ng/helm/tooltip`
- **Use**: Plain-text label shown on hover or keyboard focus. For rich content, use Hover Card.
- **Example**:
  ```html
  <button hlmTooltip="Add to library" hlmBtn variant="outline">Default</button>
  ```
- **Inputs**: `hlmTooltip` (string | `TemplateRef<void>`, required), `position` (`'top' | 'bottom' | 'left' | 'right'`, default `'top'`), `showDelay`, `hideDelay`, `tooltipDisabled`.
- **Outputs**: `show`, `hide`.
- **Gotcha**: There is no `<hlm-tooltip>` parent or `*hlmTooltipPortal`. For screen-reader users, prefer an explicit `aria-label` on icon-only triggers - tooltip content is not always announced reliably.

## See also

- [Helm conventions](helm-conventions.md) - template pattern families and shared mechanics.
- [Accessibility](accessibility.md) - focus trap, escape, ARIA roles for overlays.
- [Back to SKILL.md](../SKILL.md)
