import type { Column, Updater } from '@tanstack/angular-table'

export function resolveUpdater<TValue>(currentValue: TValue, updater: Updater<TValue>): TValue {
	return typeof updater === 'function' ? (updater as (previousValue: TValue) => TValue)(currentValue) : updater
}

export function getColumnLabel<TData extends object>(column: Column<TData, unknown>): string {
	const columnDef = column.columnDef as { header?: unknown; accessorKey?: unknown }
	if (typeof columnDef.header === 'string') {
		return columnDef.header
	}

	if (typeof columnDef.accessorKey === 'string') {
		return columnDef.accessorKey
	}

	return column.id
}
