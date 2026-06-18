# Layout

The 9 Helm components for structuring page layout - containers, separators, collapsible regions. All follow [helm-conventions.md](helm-conventions.md).

---

### Accordion

- **Pattern**: B (compound)
- **Import**: `HlmAccordionImports` from `@spartan-ng/helm/accordion`
- **Use**: Vertical stack of collapsible sections.
- **Example**:
  ```html
  <hlm-accordion type="single">
  	<hlm-accordion-item value="item-1">
  		<hlm-accordion-trigger>Is it accessible?</hlm-accordion-trigger>
  		<hlm-accordion-content>Yes. Built on Brain primitives.</hlm-accordion-content>
  	</hlm-accordion-item>
  	<hlm-accordion-item value="item-2">
  		<hlm-accordion-trigger>Is it styled?</hlm-accordion-trigger>
  		<hlm-accordion-content>Yes, with sensible Tailwind defaults.</hlm-accordion-content>
  	</hlm-accordion-item>
  </hlm-accordion>
  ```
- **Modes**: `type="single"` (one open at a time) or `type="multiple"` (any combination).
- **Gotcha**: Each item needs a unique `value` - accordion tracks open state by value, not index.

### Aspect Ratio

- **Pattern**: A (attribute directive on any element)
- **Import**: `HlmAspectRatioImports` from `@spartan-ng/helm/aspect-ratio`
- **Use**: Constrain an element to a fixed aspect ratio (e.g. 16:9 video, 1:1 square).
- **Example**:
  ```html
  <div [hlmAspectRatio]="16 / 9" class="w-full max-w-sm overflow-hidden">
  	<img ngSrc="/assets/mountains.jpg" fill alt="Mountain views" />
  </div>
  ```
- **Input**: `hlmAspectRatio` (`number | NumberInput`, default `1`). Accepts numeric values or string fractions like `"16/9"`.
- **Gotcha**: This is a directive on `<div>` - there is no `<hlm-aspect-ratio>` element. Children fill the box via `class="w-full h-full"` or `NgOptimizedImage fill`.

### Card

- **Pattern**: B (compound - directives on native elements)
- **Import**: `HlmCardImports` from `@spartan-ng/helm/card`
- **Use**: Bordered container for grouped content.
- **Example**:
  ```html
  <section hlmCard>
  	<div hlmCardHeader>
  		<h3 hlmCardTitle>Revenue</h3>
  		<p hlmCardDescription>This month vs last</p>
  		<div hlmCardAction>
  			<button hlmBtn variant="ghost" size="icon" aria-label="More">
  				<ng-icon hlm name="lucideEllipsis" />
  			</button>
  		</div>
  	</div>
  	<div hlmCardContent>
  		<p class="text-3xl font-bold">$12,345</p>
  	</div>
  	<div hlmCardFooter>
  		<button hlmBtn variant="outline" size="sm">View report</button>
  	</div>
  </section>
  ```
- **Sub-directives**: `hlmCard`, `hlmCardHeader`, `hlmCardTitle`, `hlmCardDescription`, `hlmCardAction`, `hlmCardContent`, `hlmCardFooter`.
- **Gotcha**: Card uses directives on native tags (`<section>`, `<div>`), not custom elements. You control the semantic HTML.

### Collapsible

- **Pattern**: B (compound)
- **Import**: `HlmCollapsibleImports` from `@spartan-ng/helm/collapsible`
- **Use**: A single show/hide section. For multiple, use Accordion.
- **Example**:
  ```html
  <hlm-collapsible [(expanded)]="isOpen">
  	<button hlmCollapsibleTrigger hlmBtn variant="ghost">Show more</button>
  	<hlm-collapsible-content>
  		<p>Hidden content revealed.</p>
  	</hlm-collapsible-content>
  </hlm-collapsible>
  ```
- **State binding**: `[(expanded)]` (also `expanded` input + `(expandedChange)` output).
- **Gotcha**: For animated reveal, the content must have a known height or use CSS `interpolate-size: allow-keywords` - Spartan animates `height` to `auto`, which only works with that property.

### Resizable

- **Pattern**: B (compound)
- **Import**: `HlmResizableImports` from `@spartan-ng/helm/resizable`
- **Use**: User-resizable split panes (e.g. file tree + editor).
- **Example**:
  ```html
  <hlm-resizable-group direction="horizontal" class="h-[200px] w-[500px] rounded-lg border">
  	<hlm-resizable-panel [defaultSize]="25">
  		<nav>Sidebar</nav>
  	</hlm-resizable-panel>
  	<hlm-resizable-handle withHandle />
  	<hlm-resizable-panel [defaultSize]="75">
  		<main>Content</main>
  	</hlm-resizable-panel>
  </hlm-resizable-group>
  ```
- **Group inputs**: `direction` (`'horizontal' | 'vertical'`), `layout` (`number[]`).
- **Panel inputs**: `defaultSize` (number), `minSize` (0), `maxSize` (100), `collapsible` (default `true`), `id`.
- **Handle inputs**: `withHandle` (boolean, default `false`), `disabled`.
- **Gotcha**: Group selector is `<hlm-resizable-group>` (no `panel-` prefix). The handle goes between panels, not nested inside one.

### Scroll Area

- **Pattern**: A (directive on `<ng-scrollbar>` from ngx-scrollbar)
- **Import**: `HlmScrollAreaImports` from `@spartan-ng/helm/scroll-area`
- **Dependency**: `ngx-scrollbar` (the underlying scrollbar component).
- **Use**: Custom scrollbar styling. Use when native scrollbars look out of place.
- **Example**:
  ```html
  <ng-scrollbar hlm class="h-72 w-48 rounded-md border" appearance="compact">
  	<div class="p-4" scrollViewport>
  		@for (i of items; track i) {
  		<div>Item {{ i }}</div>
  		}
  	</div>
  </ng-scrollbar>
  ```
- **Gotcha**: The component is `<ng-scrollbar>` with the `hlm` directive - **not** `<hlm-scroll-area>`. The inner container needs the `scrollViewport` directive. The outer container needs a fixed height (`h-72` etc.) or the scroll area expands to fit content.

### Separator

- **Pattern**: B (`<hlm-separator />` element) or A (`[hlmSeparator]` directive)
- **Import**: `HlmSeparatorImports` from `@spartan-ng/helm/separator`
- **Use**: Visual divider between sections.
- **Example**:
  ```html
  <hlm-separator /> <hlm-separator orientation="vertical" class="h-6" />
  ```
- **Gotcha**: Vertical separators need an explicit height (e.g. `class="h-6"`) - they have no intrinsic dimension.

### Sidebar

- **Pattern**: B (compound, wrapper directive on a `<div>` containing the sidebar element)
- **Import**: `HlmSidebarImports` from `@spartan-ng/helm/sidebar`
- **Service**: `HlmSidebarService` (state, keyboard shortcut Ctrl/⌘+B).
- **Use**: Application-level navigation sidebar.
- **Example**:
  ```html
  <div hlmSidebarWrapper>
  	<hlm-sidebar>
  		<div hlmSidebarHeader>
  			<h1>App</h1>
  		</div>
  		<div hlmSidebarContent>
  			<div hlmSidebarGroup>
  				<button hlmSidebarGroupLabel>Main</button>
  				<ul hlmSidebarMenu>
  					<li hlmSidebarMenuItem>
  						<a hlmSidebarMenuButton routerLink="/dashboard">
  							<ng-icon hlm name="lucideHouse" />
  							Dashboard
  						</a>
  					</li>
  				</ul>
  			</div>
  		</div>
  		<div hlmSidebarFooter>
  			<!-- user profile etc. -->
  		</div>
  	</hlm-sidebar>
  	<main>
  		<button hlmSidebarTrigger aria-label="Toggle sidebar"></button>
  		<!-- page content -->
  	</main>
  </div>
  ```
- **Service methods**: `setOpen(open)`, `setOpenMobile(open)`, `setVariant(variant)`, `toggleSidebar()`. Read-only signals: `open`, `openMobile`, `isMobile`, `variant`, `state` (`'expanded' | 'collapsed'`).
- **Sub-directives**: `hlmSidebarWrapper`, `hlmSidebarHeader`, `hlmSidebarContent`, `hlmSidebarFooter`, `hlmSidebarGroup`, `hlmSidebarGroupLabel`, `hlmSidebarGroupContent`, `hlmSidebarMenu`, `hlmSidebarMenuItem`, `hlmSidebarMenuButton`, `hlmSidebarMenuAction`, `hlmSidebarMenuBadge`, `hlmSidebarMenuSub`, `hlmSidebarMenuSubItem`, `hlmSidebarMenuSubButton`, `hlmSidebarSeparator`, `hlmSidebarTrigger`.
- **Gotcha**: The outer `<div hlmSidebarWrapper>` is required - it wraps both the sidebar and the main content area. Forgetting it makes the trigger silently fail.
- **Gotcha (NG0309)**: `hlmSidebarTrigger` is a **self-contained component** (selector `button[hlmSidebarTrigger]`). It already host-directives `HlmButton`, applies `provideBrnButtonConfig({ variant: 'ghost', size: 'icon' })`, and renders the `lucidePanelLeft` icon from its own template. **Do not also add `hlmBtn`** — that re-applies `BrnButton` and triggers `NG0309: Directive _BrnButton matches multiple times on the same element`. Just write `<button hlmSidebarTrigger aria-label="Toggle sidebar"></button>` with no children.

### Tabs

- **Pattern**: B (compound - directives as identifiers, not child tags)
- **Import**: `HlmTabsImports` from `@spartan-ng/helm/tabs`
- **Use**: Tabbed sections within a single view.
- **Example**:
  ```html
  <hlm-tabs tab="home">
  	<hlm-tabs-list>
  		<button hlmTabsTrigger="home">Home</button>
  		<button hlmTabsTrigger="settings">Settings</button>
  	</hlm-tabs-list>
  	<div hlmTabsContent="home">Home content</div>
  	<div hlmTabsContent="settings">Settings content</div>
  </hlm-tabs>
  ```
- **Inputs**: `tab` on `<hlm-tabs>` (the active tab id), `hlmTabsTrigger="<id>"` and `hlmTabsContent="<id>"` (the identifier string is the directive value).
- **List variants**: `variant="default" | "line"` on `<hlm-tabs-list>`.
- **Lazy content**: `<ng-template hlmTabsContentLazy="<id>">` defers rendering until activation.
- **Paginated list**: `<hlm-paginated-tabs-list>` for overflow scenarios.
- **Gotcha**: Trigger and content link by matching identifier strings - typos silently break the tab. Define values as constants if reused.

## See also

- [Helm conventions](helm-conventions.md)
- [Theming](theming.md) - Sidebar uses dedicated `--sidebar-*` theme variables.
- [Back to SKILL.md](../SKILL.md)
