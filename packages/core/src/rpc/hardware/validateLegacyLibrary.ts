import { z } from 'zod'

import { validateLegacyLibrary } from '../../hardware'
import { p } from '../trpc'
import { legacyLibraryItemSchema } from './schemas'

export default p
	.input(z.object({ libraryName: z.string(), libraries: z.array(legacyLibraryItemSchema) }))
	.query(({ input }) => validateLegacyLibrary(input.libraryName, input.libraries))
