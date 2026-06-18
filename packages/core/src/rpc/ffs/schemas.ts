import { z } from 'zod'

export const ffsFilesystemTypeSchema = z.enum(['spiffs', 'littlefs', 'fatfs'])

export const ffsPartitionSchema = z.object({
	index: z.number().int().nonnegative(),
	label: z.string(),
	type: z.number().int().nonnegative(),
	subtype: z.number().int().nonnegative(),
	typeName: z.string(),
	subtypeName: z.string(),
	offset: z.number().int().nonnegative(),
	size: z.number().int().nonnegative(),
	flags: z.number().int().nonnegative(),
	offsetHex: z.string(),
	sizeHex: z.string(),
	sizeText: z.string(),
	filesystemType: ffsFilesystemTypeSchema.nullable()
})
