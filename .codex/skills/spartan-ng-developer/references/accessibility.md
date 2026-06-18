# Accessibility

What Spartan handles automatically, what you still need to do, and where the common a11y bugs live. For Angular's broader ARIA primitives (CDK a11y, focus monitoring), defer to the `angular-developer` skill's `angular-aria.md` reference.

Claims below are sourced from the relevant Helm component pages. Where a behavior is plausibly inherited from the underlying Brain primitive or Angular CDK but not explicitly documented on the Helm page, it's marked **"Brain-level behavior (not explicitly documented on the Helm page)"**.

## 1. What Brain provides for free

Brain primitives (which every Helm component composes via `hostDirectives`) handle:

- **ARIA roles, labels, and states** - `role="dialog"`, `aria-labelledby`, `aria-describedby`, `aria-modal` are set on Dialog per the Dialog docs. Other components (menu, select, etc.) set their relevant ARIA based on state.
- **Keyboard interaction patterns** for each component class (see §4).
- **Focus management** - for Dialog, the docs explicitly mention `autoFocus` (initial focus target) and `restoreFocus` (return focus on close). See §5.
- **ID generation and association** - `<hlm-field>` wires `aria-describedby` from input to description/error elements via `BrnFieldControlDescribedBy` (per the Field docs).
- **Live region semantics** - Toast (Sonner) announces messages to assistive technology.

> ⚠ Could not verify role split (`role="status"` vs `role="alert"`) from https://spartan.ng/components/sonner - the page does not state these roles explicitly. Brain-level behavior (not explicitly documented on the Helm page): the underlying primitive typically distinguishes polite vs assertive announcements based on toast severity; confirm against the Brain source if exact role matters for your audit.

In practice: if you use Helm components as documented, most ARIA requirements are met before you write a line of a11y code.

## 2. What Helm adds on top

Beyond Brain's accessibility, Helm contributes:

- Sensible default `aria-label` values for icon-only controls in some components (e.g. `HlmBreadcrumb` defaults `aria-label="breadcrumb"`; `HlmBreadcrumbEllipsis` has `srOnlyText` default `"More"`). Verify per component.
- Visible focus indicators (focus ring) styled by the `--ring` theme variable.
- Disabled-state visual contrast.

## 3. What you still must do

Helm + Brain don't read your mind. You're responsible for:

- **Meaningful `aria-label` on icon-only triggers**: `<button hlmBtn size="icon" aria-label="Delete row"><ng-icon hlm name="lucideTrash" /></button>`. There's no text for a screen reader otherwise.
- **Image alt text**: `<hlm-avatar-image alt="...">`, image inputs, etc.
- **Heading order**: A `<h3 hlmDialogTitle>` inside a dialog doesn't change that page-level headings should be sequential (`h1` → `h2` → `h3`). Don't skip levels.
- **Page language**: Set `<html lang="en">` (or whatever locale). Spartan doesn't touch this.
- **Skip links and landmarks**: Provide a "Skip to main content" link for keyboard users. Use semantic `<main>`, `<nav>`, `<header>`, `<footer>`.

## 4. Keyboard patterns by component category

### Form controls

| Control                                       | Keys                                                               |
| --------------------------------------------- | ------------------------------------------------------------------ |
| Button, Toggle                                | Space, Enter                                                       |
| Checkbox, Switch                              | Space                                                              |
| Radio Group                                   | Arrow keys move between options, Space selects                     |
| Select, Combobox, Autocomplete, Dropdown Menu | Enter/Space opens, arrows navigate, Enter selects, Esc closes      |
| Slider                                        | Arrow keys (±step), Home/End (min/max), PageUp/PageDown (±10×step) |
| Date Picker / Calendar                        | Arrows for day-by-day, PageUp/PageDown for month, Enter selects    |
| Input OTP                                     | Auto-advance focus, Backspace returns to previous digit            |

Brain-level behavior (not explicitly documented on the Helm page): exact keystroke set per control is inherited from the underlying Brain primitive and Angular CDK a11y patterns. If a specific keystroke matters for your audit, verify against the Brain primitive source.

### Overlays

| Overlay                              | Keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dialog                               | Esc closes (per Dialog docs); focus trapped inside; focus returns to trigger on close                                                                                                                                                                                                                                                                                                                                                                                                           |
| Sheet                                | Brain-level behavior (not explicitly documented on the Helm page): the Sheet docs do not specify keyboard interaction. Sheet extends Dialog patterns, so Esc-to-close + focus trap behavior is expected from the underlying primitive - verify in your app.                                                                                                                                                                                                                                     |
| Alert Dialog                         | Brain-level behavior (not explicitly documented on the Helm page): the Alert Dialog docs do not document Esc behavior. Common ARIA practice is that Alert Dialog requires explicit action/cancel and does **not** close on Esc - but **verify with your installed version** before relying on this.                                                                                                                                                                                             |
| Popover                              | Brain-level behavior (not explicitly documented on the Helm page): the Popover docs do not document Esc behavior or focus management explicitly. The Brain `BrnPopover` typically closes on Esc and outside click - verify in your app.                                                                                                                                                                                                                                                         |
| Dropdown Menu, Context Menu, Menubar | Brain-level behavior (not explicitly documented on the Helm page): arrows navigate items, Enter/Space activates, Esc closes.                                                                                                                                                                                                                                                                                                                                                                    |
| Tooltip                              | Per the Tooltip docs (https://spartan.ng/components/tooltip), the tooltip is an **attribute directive** (`hlmTooltip` applied to a trigger element), not a compound component. The docs state it shows "when the element receives keyboard focus or the mouse hovers over it." Inputs: `hlmTooltip` (content), `position`, `showDelay`, `hideDelay`, `tooltipDisabled`. Brain-level behavior (not explicitly documented on the Helm page): close on blur and Esc behavior - verify in your app. |
| Command palette                      | Brain-level behavior (not explicitly documented on the Helm page): arrows navigate, Enter selects, Esc closes.                                                                                                                                                                                                                                                                                                                                                                                  |

### Navigation and layout

| Component  | Keys                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tabs       | Arrow keys move between triggers; Enter/Space activates                                                                                                                                           |
| Accordion  | Tab to triggers, Space/Enter toggles open/close                                                                                                                                                   |
| Carousel   | Built on Embla (per Carousel docs). Arrow-key navigation when the carousel root has focus - Brain-level behavior (not explicitly documented on the Helm page).                                    |
| Pagination | Tab through links; Enter activates                                                                                                                                                                |
| Data Table | The data-table page does not document built-in keyboard navigation - you compose with TanStack Table and Helm Table directives, so cell-level keyboard nav is whatever your composition provides. |

If a Helm component's keyboard behavior diverges from what your testing reveals, check the generated Helm source - you own those files and may have customized.

## 5. Focus management in overlays

The Dialog page documents these features explicitly; Sheet/Popover/AlertDialog docs do not, but they share the underlying Brain dialog primitive.

### `BrnDialogOptions` surface

Per `libs/brain/dialog/src/lib/brn-dialog-options.ts`, the options interface includes:

- `autoFocus: AutoFocusTarget | string` - controls initial focus on open (e.g. `'first-tabbable'`, `'first-heading'`, `'dialog'`, or a CSS selector). **`defaultFocus` is not part of this interface.**
- `restoreFocus: boolean | string | ElementRef` - returns focus to the originator (or a specified element/selector) on close.
- `ariaDescribedBy`, `ariaLabel`, `ariaLabelledBy`, `ariaModal` - ARIA wiring.
- `role: 'dialog' | 'alertdialog'` - distinguishes the two semantic roles.
- `disableClose`, `closeOnBackdropClick`, `closeOnOutsidePointerEvents` - close-behavior flags.
- Plus: `attachPositions`, `attachTo`, `backdropClass`, `closeDelay`, `hasBackdrop`, `id`, `panelClass`, `positionStrategy`, `providers`, `scrollStrategy`.

### Initial focus on open

For Dialog: Brain's primitive sets initial focus per the `autoFocus` option (Dialog docs).

To target a specific element, give it `cdkFocusInitial`:

```html
<hlm-dialog-content *hlmDialogPortal>
	<input hlmInput cdkFocusInitial />
</hlm-dialog-content>
```

### Focus trap

While Dialog is open: focus trap and focus restoration are documented features on the Dialog page. Brain-level behavior (not explicitly documented on the Helm page): the same trap mechanism is shared by Sheet, Alert Dialog, and Popover via the common Brain dialog primitive - verify in your app.

### Focus restoration on close

`restoreFocus` (per `BrnDialogOptions`) accepts `boolean | string | ElementRef`. Override only if you need to send focus elsewhere (e.g. to the newly-inserted item).

### Programmatic dialogs

When opening via `HlmDialogService.open(...)`: per the Dialog docs, "the dialog context can be injected into the dynamic component using the provided `injectBrnDialogContext`". Call `.open()` from the click handler of the originating button so focus restoration targets that element.

## 6. Screen reader smoke test

A 3-minute smoke test catches most a11y regressions:

1. **Tab through the page from the top.** Every interactive element should highlight visibly (focus ring from `--ring`) and announce its role/label.
2. **Open every overlay with the keyboard.** Verify Esc behavior for each (documented for Dialog; verify in-app for Sheet / Popover / Alert Dialog). Focus should return to the trigger on close.
3. **Activate every form control.** Selects/dropdowns should announce options as you arrow through them.

Tools by platform:

- **Windows**: NVDA (free)
- **macOS**: VoiceOver (built-in, `Cmd+F5`)
- **Linux**: Orca

Browser DevTools' "Accessibility" tab + Lighthouse a11y audit catches structural issues (missing labels, contrast) but not behavioral ones (focus, keyboard).

## 7. Common a11y bugs

| Bug                                               | Symptom                                                         | Fix                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Icon-only button missing label                    | Screen reader says "button" or reads the icon name              | Add `aria-label` on the button or trigger                                                        |
| Tooltip as the only label source                  | Tooltip content is not a reliable accessible name               | Add `aria-label` on the trigger; use Tooltip for visual hint only                                |
| Overridden host classes break disabled state      | Visually disabled but still focusable / `aria-disabled` missing | Customize the Helm source instead of overriding only the host class                              |
| Dialog opens but focus stays on the trigger       | `autoFocus` set to `false` or no focusable content              | Either let the default set initial focus, or use `cdkFocusInitial` on the right element          |
| `.dark` mode not propagated to portal containers  | Overlays render in light mode against dark page                 | Apply `.dark` to `<html>` so CDK overlay containers inherit it (default CDK behavior)            |
| Heading order skipped (`h1` → `h3` inside Dialog) | Document outline is wrong                                       | Use `<h2>` for dialog title when the page itself has `<h1>`                                      |
| Custom composition misses disabled-state ARIA     | `aria-disabled` not set, only visual disabled                   | When composing Brain primitives manually, wire `disabled` through to Brain - it handles the ARIA |
| Form submitted without focusing first error       | Keyboard user has to hunt for the broken field                  | After submit, focus the first invalid input programmatically                                     |

## See also

- [Helm conventions](helm-conventions.md) - `hostDirectives` is what plumbs Brain's a11y into Helm.
- [Overlays](overlays.md) - overlay-specific behaviors (focus trap, escape).
- [Form controls](form-controls.md) and [Forms integration](forms.md) - form-specific a11y patterns.
- `angular-developer` skill's `angular-aria.md` - Angular CDK a11y primitives.
- [Back to SKILL.md](../SKILL.md)
