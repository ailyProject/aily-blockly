import { z } from 'zod'

import { searchHardwareIndexCompat } from '../../hardware'
import { p } from '../trpc'
import { boardIndexItemSchema, legacyBoardItemSchema, legacyLibraryItemSchema, libraryIndexItemSchema } from './schemas'

export default p
	.input(
		z.object({
			boards: z.array(boardIndexItemSchema),
			libraries: z.array(libraryIndexItemSchema),
			query: z.object({
				query: z.union([z.string(), z.array(z.string())]).optional(),
				type: z.enum(['boards', 'libraries', 'both']).optional(),
				filters: z
					.object({
						keywords: z.union([z.string(), z.array(z.string())]).optional(),
						flash: z.string().optional(),
						sram: z.string().optional(),
						frequency: z.string().optional(),
						cores: z.string().optional(),
						architecture: z.string().optional(),
						connectivity: z.array(z.string()).optional(),
						interfaces: z.array(z.string()).optional(),
						brand: z.string().optional(),
						voltage: z.string().optional(),
						category: z.string().optional(),
						hardwareType: z.array(z.string()).optional(),
						supportedCores: z.array(z.string()).optional(),
						communication: z.array(z.string()).optional()
					})
					.optional(),
				maxResults: z.number().optional()
			}),
			legacy: z
				.object({
					legacyBoards: z.array(legacyBoardItemSchema).optional(),
					legacyLibraries: z.array(legacyLibraryItemSchema).optional()
				})
				.optional()
		})
	)
	.query(({ input }) => searchHardwareIndexCompat(input.boards, input.libraries, input.query, input.legacy))
