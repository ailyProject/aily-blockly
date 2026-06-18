import { z } from 'zod'

import { getConnectionLibraryInfo } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ pinmapId: z.string(), packagesBasePath: z.string() }))
	.query(({ input }) => getConnectionLibraryInfo(input.pinmapId, input.packagesBasePath))
