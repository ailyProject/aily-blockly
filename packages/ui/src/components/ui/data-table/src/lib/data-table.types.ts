import type { ColumnDef } from '@tanstack/angular-table'

export type DataTableColumn<TData extends object = Record<string, unknown>> = ColumnDef<TData, unknown>

export type DataTableRow<TData extends object = Record<string, unknown>> = TData
