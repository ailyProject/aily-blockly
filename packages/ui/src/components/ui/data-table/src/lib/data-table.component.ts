import { Component, computed, input, signal } from '@angular/core'
import {
	createAngularTable,
	FlexRenderDirective,
	getCoreRowModel,
	getFilteredRowModel,
	getPaginationRowModel,
	getSortedRowModel
} from '@tanstack/angular-table'
import { HlmButtonImports } from 'spartan/button'
import { HlmDropdownMenuImports } from 'spartan/dropdown-menu'
import { HlmInputImports } from 'spartan/input'
import { HlmTableImports } from 'spartan/table'

import { getColumnLabel, resolveUpdater } from './data-table-utils'

import type {
	ColumnFiltersState,
	RowData,
	RowSelectionState,
	SortingState,
	VisibilityState
} from '@tanstack/angular-table'
import type { DataTableColumn } from './data-table-types'

@Component({
	selector: 'ui-data-table',
	imports: [FlexRenderDirective, HlmButtonImports, HlmDropdownMenuImports, HlmInputImports, HlmTableImports],
	templateUrl: './data-table.component.html',
	styleUrl: './data-table.component.css'
})
export class DataTableComponent<TData extends object = Record<string, unknown>> {
	readonly columns = input.required<DataTableColumn<TData>[]>()
	readonly data = input.required<TData[]>()
	readonly emptyMessage = input('No results.')
	readonly filterColumnId = input<string | null>(null)
	readonly filterPlaceholder = input('Filter rows...')

	private readonly sorting = signal<SortingState>([])
	private readonly columnFilters = signal<ColumnFiltersState>([])
	private readonly columnVisibility = signal<VisibilityState>({})
	private readonly rowSelection = signal<RowSelectionState>({})

	protected readonly table = createAngularTable(() => ({
		data: this.data(),
		columns: this.columns(),
		state: {
			sorting: this.sorting(),
			columnFilters: this.columnFilters(),
			columnVisibility: this.columnVisibility(),
			rowSelection: this.rowSelection()
		},
		onSortingChange: updater => this.sorting.set(resolveUpdater(this.sorting(), updater)),
		onColumnFiltersChange: updater => this.columnFilters.set(resolveUpdater(this.columnFilters(), updater)),
		onColumnVisibilityChange: updater => this.columnVisibility.set(resolveUpdater(this.columnVisibility(), updater)),
		onRowSelectionChange: updater => this.rowSelection.set(resolveUpdater(this.rowSelection(), updater)),
		getCoreRowModel: getCoreRowModel(),
		getFilteredRowModel: getFilteredRowModel(),
		getSortedRowModel: getSortedRowModel(),
		getPaginationRowModel: getPaginationRowModel()
	}))

	protected readonly visibleColumns = computed(() =>
		this.table()
			.getAllColumns()
			.filter(column => column.getCanHide())
	)

	protected readonly currentFilterValue = computed(() => {
		const columnId = this.filterColumnId()
		if (!columnId) {
			return ''
		}

		return String(this.table().getColumn(columnId)?.getFilterValue() ?? '')
	})

	protected readonly pageSummary = computed(() => {
		const table = this.table()
		return `${table.getState().pagination.pageIndex + 1} / ${table.getPageCount() || 1}`
	})

	protected handleFilterChange(filterValue: string) {
		const columnId = this.filterColumnId()
		if (!columnId) {
			return
		}

		this.table().getColumn(columnId)?.setFilterValue(filterValue)
	}

	protected getColumnLabel = getColumnLabel
}
