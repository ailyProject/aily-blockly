import type { ColumnDef } from '@tanstack/angular-table'

/**
 * 数据表格列定义别名
 */
export type DataTableColumn<TData extends object = Record<string, unknown>> = ColumnDef<TData, unknown>

/**
 * 数据表格行数据别名
 */
export type DataTableRow<TData extends object = Record<string, unknown>> = TData
