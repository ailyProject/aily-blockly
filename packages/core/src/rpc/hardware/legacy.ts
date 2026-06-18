import { z } from 'zod'

import { validateLegacyBoard, validateLegacyLibrary } from '../../hardware'
import { p } from '../trpc'
import { legacyBoardItemSchema, legacyLibraryItemSchema } from './schemas'

export const validateBoard = p
	.input(z.object({ boardName: z.string(), boards: z.array(legacyBoardItemSchema) }))
	.query(({ input }) => validateLegacyBoard(input.boardName, input.boards))

export const validateLibrary = p
	.input(z.object({ libraryName: z.string(), libraries: z.array(legacyLibraryItemSchema) }))
	.query(({ input }) => validateLegacyLibrary(input.libraryName, input.libraries))
