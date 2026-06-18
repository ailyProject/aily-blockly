import { z } from 'zod'

import { getBoardCategories, getLibraryCategories } from '../../hardware'
import { p } from '../trpc'
import { boardIndexItemSchema, libraryIndexItemSchema } from './schemas'

export const boardCategories = p
	.input(
		z.object({
			boards: z.array(boardIndexItemSchema),
			dimension: z.enum(['brand', 'architecture', 'connectivity', 'interfaces', 'tags'])
		})
	)
	.query(({ input }) => getBoardCategories(input.boards, input.dimension))

export const libraryCategories = p
	.input(
		z.object({
			libraries: z.array(libraryIndexItemSchema),
			dimension: z.enum(['category', 'hardwareType', 'communication', 'supportedCores'])
		})
	)
	.query(({ input }) => getLibraryCategories(input.libraries, input.dimension))
