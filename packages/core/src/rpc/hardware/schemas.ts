import { z } from 'zod'

export const legacyBoardItemSchema = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	displayName: z.string().optional(),
	description: z.string().optional(),
	keywords: z.array(z.string()).optional(),
	brand: z.string().optional(),
	type: z.string().optional()
})

export const legacyLibraryItemSchema = z.object({
	name: z.string(),
	nickname: z.string().optional(),
	description: z.string().optional(),
	keywords: z.array(z.string()).optional(),
	author: z.string().optional(),
	compatibility: z.object({ core: z.array(z.string()).optional() }).optional()
})

export const boardIndexItemSchema = z.object({
	name: z.string(),
	displayName: z.string(),
	brand: z.string(),
	type: z.enum(['board', 'series']),
	architecture: z.string(),
	cores: z.number(),
	frequency: z.number(),
	frequencyUnit: z.string(),
	flash: z.number(),
	sram: z.number(),
	psram: z.number(),
	connectivity: z.array(z.string()),
	interfaces: z.array(z.string()),
	core: z.string(),
	voltage: z.number(),
	mcu: z.string().optional(),
	gpio: z.object({ digital: z.number(), analog: z.number(), pwm: z.number() }).optional(),
	features: z.array(z.string()).optional(),
	tags: z.array(z.string()),
	keywords: z.array(z.string()).optional(),
	description: z.string().optional()
})

export const libraryIndexItemSchema = z.object({
	name: z.string(),
	displayName: z.string(),
	category: z.string(),
	supportedCores: z.array(z.string()),
	communication: z.array(z.string()),
	voltage: z.array(z.number()),
	hardwareType: z.array(z.string()),
	compatibleHardware: z.array(z.string()),
	tags: z.array(z.string()),
	subcategory: z.string().optional(),
	functions: z.array(z.string()).optional(),
	keywords: z.array(z.string()).optional(),
	description: z.string().optional(),
	author: z.string().optional()
})

export const hardwareRunUploadInputSchema = z.object({
	projectPath: z.string(),
	appDataPath: z.string(),
	childPath: z.string(),
	code: z.string().optional(),
	portType: z.enum(['serial', 'ble', 'debugger']).optional(),
	serialPort: z.string().optional(),
	probeSerial: z.string().optional(),
	probeVidPid: z.string().optional(),
	pnum: z.string().optional(),
	rebuildBeforeUpload: z.boolean().optional(),
	use1200bpsTouch: z.boolean().optional(),
	waitForUpload: z.boolean().optional()
})

export const hardwarePrepareBleUploadInputSchema = z.object({
	projectPath: z.string(),
	appDataPath: z.string(),
	childPath: z.string(),
	code: z.string().optional(),
	rebuildBeforeUpload: z.boolean().optional(),
	updateType: z.enum(['flash', 'filesystem']).optional(),
	packetSize: z.number().int().positive().optional()
})
