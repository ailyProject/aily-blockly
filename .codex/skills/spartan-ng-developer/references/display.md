# Display

The 10 Helm components for presentational display - badges, icons, status indicators. Mostly stateless and visual. All follow [helm-conventions.md](helm-conventions.md).

---

### Alert

- **Pattern**: B (`<hlm-alert>` element) or A (`[hlmAlert]` directive)
- **Import**: `HlmAlertImports` from `@spartan-ng/helm/alert`
- **Use**: Inline informational or error banner. **Not** a modal - for that use Alert Dialog.
- **Example**:

  ```html
  <hlm-alert>
  	<ng-icon hlm name="lucideInfo" />
  	<h4 hlmAlertTitle>Heads up</h4>
  	<p hlmAlertDescription>You can change this setting later.</p>
  </hlm-alert>

  <hlm-alert variant="destructive">
  	<ng-icon hlm name="lucideTriangleAlert" />
  	<h4 hlmAlertTitle>Something went wrong</h4>
  	<p hlmAlertDescription>Check the logs.</p>
  </hlm-alert>
  ```

- **Variants**: `'default' | 'destructive'`.
- **Sub-slots**: `[hlmAlertTitle]`, `[hlmAlertDescription]`, `[hlmAlertAction]`.
- **Icons**: place `<ng-icon hlm name="lucideX" />` directly inside `<hlm-alert>`; layout auto-adjusts via CSS grid.
- **Gotcha**: Alert is for static messages. For transient notifications use Sonner (Toast).

### Avatar

- **Pattern**: B (`<hlm-avatar>` element with directive-on-`<img>` / directive-on-`<span>` children)
- **Import**: `HlmAvatarImports` from `@spartan-ng/helm/avatar`
- **Use**: User profile picture with initials fallback.
- **Example**:
  ```html
  <hlm-avatar>
  	<img hlmAvatarImage src="/assets/avatar.png" alt="Mofiro Jean" />
  	<span hlmAvatarFallback>MJ</span>
  </hlm-avatar>
  ```
- **Variants**: `size` accepts `'default' | 'sm' | 'lg'`.
- **Gotcha**: The image is `<img hlmAvatarImage>` (directive on `<img>`), the fallback is `<span hlmAvatarFallback>` (directive on `<span>`) - **not** `<hlm-avatar-image>` / `<hlm-avatar-fallback>` element children. The fallback shows only if the image fails to load.

### Badge

- **Pattern**: A (directive on any inline element)
- **Import**: `HlmBadgeImports` from `@spartan-ng/helm/badge`
- **Use**: Small status indicator (counts, labels, statuses).
- **Example**:
  ```html
  <span hlmBadge>New</span>
  <span hlmBadge variant="outline">Pending</span>
  <span hlmBadge variant="destructive">3</span>
  ```
- **Variants**: `'default' | 'secondary' | 'destructive' | 'outline' | 'ghost' | 'link'`.
- **Gotcha**: Badges are inline. For notification dots on another element, wrap in a `relative` container and absolute-position the badge.

### Empty

- **Pattern**: B (compound)
- **Import**: `HlmEmptyImports` from `@spartan-ng/helm/empty`
- **Use**: Empty-state placeholder when a list/grid has no items.
- **Example**:
  ```html
  <hlm-empty>
  	<hlm-empty-header>
  		<hlm-empty-media variant="icon">
  			<ng-icon hlm name="lucideFolderCode" />
  		</hlm-empty-media>
  		<div hlmEmptyTitle>No Projects Yet</div>
  		<div hlmEmptyDescription>Create your first project to get started.</div>
  	</hlm-empty-header>
  	<hlm-empty-content>
  		<button hlmBtn>Create Project</button>
  	</hlm-empty-content>
  </hlm-empty>
  ```
- **Sub-components**: `<hlm-empty-header>`, `<hlm-empty-media variant="default|icon">`, `<hlm-empty-content>`. Title and description are directives: `[hlmEmptyTitle]`, `[hlmEmptyDescription]`.
- **Gotcha**: An empty state should also offer the user a _next action_ (button in `<hlm-empty-content>`).

### Icon

- **Pattern**: A (directive `hlm` on `<ng-icon>` from `@ng-icons/core`)
- **Imports**: `HlmIcon` from `@spartan-ng/helm/icon`, `NgIcon` from `@ng-icons/core`, plus icon definitions from `@ng-icons/lucide` (or another `@ng-icons/*` set).
- **Use**: Render an SVG icon. Spartan defaults to Lucide via `@ng-icons`.
- **Example**:

  ```ts
  import { NgIcon, provideIcons } from '@ng-icons/core';
  import { lucideChevronRight } from '@ng-icons/lucide';
  import { HlmIcon } from '@spartan-ng/helm/icon';

  @Component({
    imports: [NgIcon, HlmIcon],
    providers: [provideIcons({ lucideChevronRight })],
    template: `<ng-icon hlm size="lg" name="lucideChevronRight" />`,
  })
  ```

- **Sizes**: `size` accepts presets `'xs' | 'sm' | 'base' | 'lg' | 'xl'` or any CSS value (`size="64px"`). Alternatively style with Tailwind `text-*` utilities.
- **Gotcha**: Use `<ng-icon hlm name="lucideX">` - **not** `<hlm-icon name="x">`. Names are camelCased with a `lucide` prefix (`lucideSettings`, `lucideChevronDown`). Unregistered icon names render silently as nothing - always `provideIcons` the icons you use.

### Item

- **Pattern**: B (compound)
- **Import**: `HlmItemImports` from `@spartan-ng/helm/item`
- **Use**: Generic structured list-item primitive - leading media + content (title + description) + trailing actions.
- **Example**:
  ```html
  <hlm-item variant="outline">
  	<hlm-item-media variant="icon">
  		<ng-icon hlm name="lucideBadgeCheck" />
  	</hlm-item-media>
  	<hlm-item-content>
  		<hlm-item-title>Verified</hlm-item-title>
  		<p hlmItemDescription>This account is verified.</p>
  	</hlm-item-content>
  	<hlm-item-actions>
  		<button hlmBtn>Manage</button>
  	</hlm-item-actions>
  </hlm-item>
  ```
- **Sub-components**: `<hlm-item-media>`, `<hlm-item-content>`, `<hlm-item-title>`, `<hlm-item-description>` (also `[hlmItemDescription]`), `<hlm-item-actions>`, `<hlm-item-header>`, `<hlm-item-footer>`.
- **Variants**: `'default' | 'outline' | 'muted'`.
- **Sizes**: `'default' | 'sm' | 'xs'`.
- **Gotcha**: Item is unopinionated about its outer tag - wrap in `<a>` for navigation, `<button>` for actions, `<li>` for lists if you need the semantics.

### Kbd

- **Pattern**: A (directive on `<kbd>`)
- **Import**: `HlmKbdImports` from `@spartan-ng/helm/kbd`
- **Use**: Display keyboard shortcut tokens (⌘K, Ctrl+S).
- **Example**:
  ```html
  Press <kbd hlmKbd>⌘</kbd><kbd hlmKbd>K</kbd> to open.
  ```
- **Group**: wrap a related run of keys in a `<kbd hlmKbdGroup>` for combined styling.
- **Gotcha**: Use the semantic `<kbd>` tag - screen readers announce it correctly.

### Progress

- **Pattern**: B (`<hlm-progress>` element)
- **Import**: `HlmProgressImports` from `@spartan-ng/helm/progress`
- **Use**: Determinate progress bar (0–100). For unknown duration use Spinner.
- **Example**:
  ```html
  <hlm-progress [value]="uploadPercent()" />
  ```
- **Inputs**: `value` (clamped to `[0, max]`), `max` (default `100`).
- **Indeterminate**: omit `value` (or set to `undefined`).
- **Gotcha**: Out-of-range `value` is clamped silently - guard your inputs.

### Skeleton

- **Pattern**: B (`<hlm-skeleton>` element)
- **Import**: `HlmSkeletonImports` from `@spartan-ng/helm/skeleton`
- **Use**: Animated placeholder shape while content loads.
- **Example**:
  ```html
  <hlm-skeleton class="h-12 w-12 rounded-full" />
  <hlm-skeleton class="h-4 w-[250px]" />
  <hlm-skeleton class="h-4 w-[200px]" />
  ```
- **Gotcha**: Set explicit width and height with Tailwind utilities - skeleton has no intrinsic dimensions and collapses to 0 otherwise.

### Spinner

- **Pattern**: B (`<hlm-spinner>` element)
- **Import**: `HlmSpinnerImports` from `@spartan-ng/helm/spinner`
- **Use**: Indeterminate loading indicator. For known progress use Progress.
- **Example**:
  ```html
  <hlm-spinner /> <hlm-spinner class="size-6" aria-label="Loading projects" />
  ```
- **Inputs**: `icon` (default `lucideLoader2`), `aria-label`.
- **Gotcha**: There is **no** `size` input - size via Tailwind utilities (`size-6`, `text-xl`, etc.). Pair with an accessible label for screen readers.

## See also

- [Helm conventions](helm-conventions.md)
- [Accessibility](accessibility.md) - ARIA labels for icon-only displays and loading indicators.
- [Back to SKILL.md](../SKILL.md)
