import { z } from 'zod'

import { scanConnectionPinmapCatalogs } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ packagesBasePath: z.string() }))
	.query(({ input }) => scanConnectionPinmapCatalogs(input.packagesBasePath))
