import { createColumnHelper } from '@tanstack/angular-table'

import type { DataTableColumn } from '@/components/ui/data-table/src/lib/data-table.types'

type BoardRow = {
	name: string
	core: string
	status: string
	updatedAt: string
}

const columnHelper = createColumnHelper<BoardRow>()

export const boardRows: BoardRow[] = [
	{ name: 'xiao-esp32s3', core: 'esp32', status: 'stable', updatedAt: '2026-06-10' },
	{ name: 'microbit-v2', core: 'nrf52', status: 'beta', updatedAt: '2026-06-08' },
	{ name: 'uno-r4', core: 'renesas', status: 'stable', updatedAt: '2026-06-06' },
	{ name: 'stm32f103', core: 'stm32', status: 'preview', updatedAt: '2026-06-03' }
]

export const boardColumns: DataTableColumn<BoardRow>[] = [
	columnHelper.accessor('name', { header: 'Board', cell: info => info.getValue() }),
	columnHelper.accessor('core', { header: 'Core', cell: info => info.getValue() }),
	columnHelper.accessor('status', { header: 'Status', cell: info => info.getValue() }),
	columnHelper.accessor('updatedAt', { header: 'Updated', cell: info => info.getValue() })
]
