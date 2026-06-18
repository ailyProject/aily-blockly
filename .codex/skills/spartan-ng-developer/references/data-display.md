# Data Display

The 6 Helm components for navigation and tabular/temporal data display. All follow [helm-conventions.md](helm-conventions.md).

All claims below are sourced from the official spartan.ng component pages cited per entry.

---

### Breadcrumb

- **Pattern**: B (compound)
- **Source**: https://spartan.ng/components/breadcrumb
- **Import**: `HlmBreadcrumbImports` from `@spartan-ng/helm/breadcrumb`
- **Use**: "Displays the path to the current resource using a hierarchy of links."
- **Selectors** (all attribute directives unless noted):
  - `[hlmBreadcrumb]` - nav wrapper
  - `[hlmBreadcrumbList]` - applied to `<ol>`
  - `[hlmBreadcrumbItem]` - applied to `<li>`
  - `[hlmBreadcrumbLink]` - clickable link
  - `[hlmBreadcrumbPage]` - current page (non-interactive)
  - `[hlmBreadcrumbSeparator]` - visual divider
  - `hlm-breadcrumb-ellipsis` - element component for collapsed overflow
- **Key inputs**:
  - `HlmBreadcrumbLink.link` - `RouterLink['routerLink']` navigation target
  - `HlmBreadcrumbEllipsis.srOnlyText` - screen reader text (default `"More"`)
  - `HlmBreadcrumb` accepts `aria-label` (default `"breadcrumb"`)
- **Example** (from docs):
  ```html
  <nav hlmBreadcrumb>
  	<ol hlmBreadcrumbList>
  		<li hlmBreadcrumbItem>
  			<a hlmBreadcrumbLink link="/">Home</a>
  		</li>
  		<li hlmBreadcrumbSeparator></li>
  		<li hlmBreadcrumbItem>
  			<span hlmBreadcrumbPage>Current Page</span>
  		</li>
  	</ol>
  </nav>
  ```
- **Gotcha**: The final crumb (current page) should be `hlmBreadcrumbPage`, not `hlmBreadcrumbLink` - it's the current location, not navigable. Spartan sets `aria-current="page"` on it automatically.

---

### Calendar

- **Pattern**: B (three sibling element components)
- **Source**: https://spartan.ng/components/calendar
- **Import**: `HlmCalendarImports` from `@spartan-ng/helm/calendar`
- **Use**: Inline month calendar grid for single, multi-select, or range selection.
- **Three distinct selectors - pick the one matching the selection mode**:
  - `<hlm-calendar>` - single date
  - `<hlm-calendar-multi>` - multiple dates
  - `<hlm-calendar-range>` - date range
- **Two-way binding inputs**:
  - Single: `[(date)]="aDate"` (`T`)
  - Multi: `[(date)]="dates"` (`T[]`)
  - Range: `[(startDate)]="from"` and `[(endDate)]="to"` - **separate inputs, NOT a `{ from, to }` object**
- **Common inputs (all three)**:
  - `[min]`, `[max]` - minimum/maximum selectable date
  - `[disabled]` - disables the whole calendar (boolean)
  - `[dateDisabled]` - predicate `(date: T) => boolean` for per-date disable. **Note this is `dateDisabled`, not `disabled`.**
  - `[weekStartsOn]`
  - `[defaultFocusedDate]`
  - `[highlightDays]`
  - `[captionLayout]` - one of `'dropdown' | 'label' | 'dropdown-months' | 'dropdown-years'`
- **Multi-only**: `[minSelection]`, `[maxSelection]`
- **Brain directive selectors**: `[brnCalendar]`, `[brnCalendarMulti]`, `[brnCalendarRange]`, plus layout directives `[brnCalendarCell]`, `[brnCalendarGrid]`, `[brnCalendarWeek]`.
- **Examples**:

  ```html
  <!-- Single -->
  <hlm-calendar [(date)]="selectedDate" [min]="minDate" [max]="maxDate" />

  <!-- Multi (cap at 3 picks) -->
  <hlm-calendar-multi [(date)]="picks" [maxSelection]="3" />

  <!-- Range with disabled-date predicate -->
  <hlm-calendar-range [(startDate)]="from" [(endDate)]="to" [dateDisabled]="isWeekend" />
  ```

- **Locale**: Driven by Angular's `LOCALE_ID` and `registerLocaleData`. Configure at bootstrap.
- **Gotcha**: Don't reach for `<hlm-calendar mode="range">` - that's not the API. The mode is encoded in the selector (`<hlm-calendar-range>`), and the range value is two separate model signals, not one object.

---

### Carousel

- **Pattern**: B (compound)
- **Source**: https://spartan.ng/components/carousel
- **Import**: `HlmCarouselImports` from `@spartan-ng/helm/carousel`
- **Built on Embla**: "Embla Carousel library and the embla-carousel-angular wrapper" per docs.
- **Selectors**:
  - `<hlm-carousel>` - root
  - `<hlm-carousel-content>` or `[hlmCarouselContent]`
  - `<hlm-carousel-item>` or `[hlmCarouselItem]`
  - `<button hlm-carousel-previous>` (element-selector on `<button>`; `[hlmCarouselPrevious]` form also exists)
  - `<button hlm-carousel-next>` (element-selector on `<button>`; `[hlmCarouselNext]` form also exists)
  - `<hlm-carousel-slide-display>` - current-slide indicator
- **`HlmCarousel` inputs**:
  - `orientation: 'horizontal' | 'vertical'` (default `'horizontal'`)
  - `options: Omit<EmblaOptionsType, 'axis'>` - Embla configuration (loop, slidesToScroll, etc.). **Note: input name is `options`, not `opts`.**
  - `plugins: EmblaPluginType[]` (default `[]`) - separate input for plugins like `embla-carousel-autoplay`.
- **Example** (from docs):
  ```ts
  @Component({
  	imports: [HlmCarouselImports, HlmCardImports],
  	template: `
  		<hlm-carousel class="w-full max-w-xs">
  			<hlm-carousel-content>
  				@for (item of items; track item) {
  					<hlm-carousel-item>
  						<div class="p-1">
  							<section hlmCard>
  								<p hlmCardContent class="flex aspect-square items-center justify-center p-6">
  									<span class="text-4xl font-semibold">{{ item }}</span>
  								</p>
  							</section>
  						</div>
  					</hlm-carousel-item>
  				}
  			</hlm-carousel-content>
  			<button hlm-carousel-previous></button>
  			<button hlm-carousel-next></button>
  		</hlm-carousel>
  	`
  })
  export class CarouselPreview {
  	public items = Array.from({ length: 5 }, (_, i) => i + 1)
  }
  ```
- **Gotcha**: Autoplay isn't built-in - install `embla-carousel-autoplay` and pass it via `[plugins]`. The previous/next selectors are element-form on a `<button>` (`<button hlm-carousel-previous>`), not attribute-form.

---

### Data Table

- **Pattern**: TanStack Table + Helm Table directives (there is **no `<hlm-data-table>` component**).
- **Source**: https://spartan.ng/components/data-table
- **Use**: Full-featured table - sort, filter, paginate, row select, column visibility - composed yourself on top of `@tanstack/angular-table` and styled with `HlmTableImports`.
- **Imports** (from the docs example):

  ```ts
  import {
  	ColumnDef,
  	ColumnFiltersState,
  	createAngularTable,
  	flexRenderComponent,
  	FlexRenderDirective,
  	getCoreRowModel,
  	getFilteredRowModel,
  	getPaginationRowModel,
  	getSortedRowModel,
  	RowSelectionState,
  	SortingState,
  	VisibilityState
  } from '@tanstack/angular-table'

  // Plus Helm directives/components for styling:
  // HlmButtonImports, HlmDropdownMenuImports, HlmIconImports,
  // HlmInputImports, HlmTableImports
  ```

- **Core pattern**:
  1. Define `columns: ColumnDef<TRow>[]`.
  2. Create the table instance with `createAngularTable(() => ({ data, columns, state, getCoreRowModel: getCoreRowModel(), ... }))`.
  3. Render cells with `flexRenderComponent(...)` and the `FlexRenderDirective` in the template.
  4. Apply Helm directives (`hlmTable`, `hlmTableContainer`, `hlmTableHeader`, `hlmTableBody`, `hlmTableRow`, `hlmTableHead`, `hlmTableCell`) to the native table elements for styling.
- **Features in the reference example**: sorting (`TableHeadSortButton` + `getSortedRowModel()`), email-column filtering (`getFilteredRowModel()`), pagination buttons (`getPaginationRowModel()`), checkbox row selection (`TableHeadSelection` + `TableRowSelection`), column visibility toggle via a dropdown menu (`VisibilityState`).
- **Gotcha**: There is no single `[data]`/`[columns]` input to wire - you orchestrate the TanStack `Table` object yourself and bind its row/header models in the template. Treat the docs example as a starting template to copy and adapt.

> ⚠ Could not verify a single canonical Helm "data table component" wrapper from https://spartan.ng/components/data-table - the page presents the pattern as a recipe, not a sealed component. The directive names shown on the data-table page (`hlmTHead`, `hlmTBody`, `hlmTr`, `hlmTh`, `hlmTd`) are short aliases for the same directives documented on the Table page (`hlmTableHeader`, `hlmTableBody`, `hlmTableRow`, `hlmTableHead`, `hlmTableCell`) - both selectors are bound on the same directives.

---

### Pagination

- **Pattern**: B (compound, presentational + stateful numbered variant)
- **Source**: https://spartan.ng/components/pagination
- **Import**: `HlmPaginationImports` from `@spartan-ng/helm/pagination`
- **Use**: Page navigation controls - previous/next, page numbers, ellipsis.
- **Selectors**:
  - `[hlmPagination]` (or `<hlm-pagination>`) - outer `<nav>`
  - `ul[hlmPaginationContent]` - content container (directive on `<ul>`)
  - `li[hlmPaginationItem]` - each item (directive on `<li>`)
  - `[hlmPaginationLink]` - attribute directive on the page-number anchor
  - `<hlm-pagination-previous>` - element component for "Previous"
  - `<hlm-pagination-next>` - element component for "Next"
  - `<hlm-pagination-ellipsis>` - element component for the `…` gap
- **Key inputs**:
  - `HlmPaginationLink`: `isActive: boolean`, `size: ButtonVariants['size']` (default `'icon'`), `link` (RouterLink-compatible)
  - `HlmPaginationNext` / `HlmPaginationPrevious`: `link`, `queryParams`, `queryParamsHandling`, `ariaLabel`, `text`, `iconOnly: boolean`
  - `HlmNumberedPaginationQueryParams` (the stateful variant): required model inputs `currentPage: number` and `itemsPerPage: number`, required `totalItems: number`, optional `maxSize: number` (default 7), `showEdges: boolean` (default true), `pageSizes: number[]` (default `[10, 20, 50, 100]`)
- **Example** (from docs):
  ```html
  <nav hlmPagination>
  	<ul hlmPaginationContent>
  		<li hlmPaginationItem>
  			<hlm-pagination-previous link="/components/menubar" />
  		</li>
  		<li hlmPaginationItem>
  			<a hlmPaginationLink link="#">1</a>
  		</li>
  		<li hlmPaginationItem>
  			<a hlmPaginationLink link="#" [isActive]="true">2</a>
  		</li>
  		<li hlmPaginationItem>
  			<hlm-pagination-ellipsis />
  		</li>
  		<li hlmPaginationItem>
  			<hlm-pagination-next link="/components/popover" />
  		</li>
  	</ul>
  </nav>
  ```
- **Gotcha**: The plain compound (`hlmPagination` + links) is presentational - you compute which page numbers/ellipses to render. If you want state management (current page, total items, page size), use the numbered variant which exposes `currentPage` and `itemsPerPage` as model inputs.

---

### Table

- **Pattern**: B (directives on native table elements - no element components)
- **Source**: https://spartan.ng/components/table
- **Import**: `HlmTableImports` from `@spartan-ng/helm/table`
- **Use**: Styled native `<table>`. For sort/filter/paginate, layer TanStack Table on top (see Data Table).
- **Directives** (each works on the matching native tag; both long-form and short-form selectors are valid aliases for the same directive):
  | Directive | Selectors |
  |---|---|
  | `HlmTableContainer` | `div[hlmTableContainer]` |
  | `HlmTable` | `table[hlmTable]` |
  | `HlmTHead` | `thead[hlmTableHeader]`, `thead[hlmTHead]` |
  | `HlmTBody` | `tbody[hlmTableBody]`, `tbody[hlmTBody]` |
  | `HlmTFoot` | `tfoot[hlmTableFooter]`, `tfoot[hlmTFoot]` |
  | `HlmTr` | `tr[hlmTableRow]`, `tr[hlmTr]` |
  | `HlmTh` | `th[hlmTableHead]`, `th[hlmTh]` |
  | `HlmTd` | `td[hlmTableCell]`, `td[hlmTd]` |
  | `HlmCaption` | `caption[hlmTableCaption]`, `caption[hlmCaption]` |
- **Example** (verbatim from docs):
  ```html
  <div hlmTableContainer>
  	<table hlmTable>
  		<caption hlmTableCaption>
  			A list of your recent invoices.
  		</caption>
  		<thead hlmTableHeader>
  			<tr hlmTableRow>
  				<th hlmTableHead class="w-[100px]">Invoice</th>
  				<th hlmTableHead>Status</th>
  				<th hlmTableHead>Method</th>
  				<th hlmTableHead class="text-right">Amount</th>
  			</tr>
  		</thead>
  		<tbody hlmTableBody>
  			@for (invoice of _invoices; track invoice.invoice) {
  			<tr hlmTableRow>
  				<td hlmTableCell class="font-medium">{{ invoice.invoice }}</td>
  				<td hlmTableCell>{{ invoice.paymentStatus }}</td>
  				<td hlmTableCell>{{ invoice.paymentMethod }}</td>
  				<td hlmTableCell class="text-right">{{ invoice.totalAmount }}</td>
  			</tr>
  			}
  		</tbody>
  		<tfoot hlmTableFooter>
  			<tr hlmTableRow>
  				<td hlmTableCell [attr.colSpan]="3">Total</td>
  				<td hlmTableCell class="text-right">$2,500.00</td>
  			</tr>
  		</tfoot>
  	</table>
  </div>
  ```
- **Gotcha**: Use real `<table>` / `<tr>` / `<td>` - Spartan only attaches styling to these tags. Don't substitute `<div>`. The long names (`hlmTableRow`, `hlmTableHead`, `hlmTableCell`, etc.) and the short aliases (`hlmTr`, `hlmTh`, `hlmTd`, `hlmTHead`, `hlmTBody`, `hlmTFoot`) bind the same directives - prefer the long names for clarity.

## See also

- [Helm conventions](helm-conventions.md)
- [Form controls](form-controls.md) - Date Picker uses Calendar internally.
- [Accessibility](accessibility.md) - table semantics, pagination keyboard nav.
- [Back to SKILL.md](../SKILL.md)
