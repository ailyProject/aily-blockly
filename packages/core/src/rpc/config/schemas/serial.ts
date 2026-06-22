import { z } from 'zod'

import type { QuickSendItem, SerialMonitorConfig } from 'shared'

export const quickSendItemSchema: z.ZodType<QuickSendItem> = z.object({
	name: z.string(),
	type: z.enum(['signal', 'text', 'hex']),
	data: z.string()
})

export const serialMonitorSchema: z.ZodType<SerialMonitorConfig> = z.object({
	port: z.string().optional(),
	baudRate: z.string().optional(),
	dataBits: z.string().optional(),
	stopBits: z.string().optional(),
	parity: z.string().optional(),
	flowControl: z.string().optional()
})
