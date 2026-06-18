import { z } from 'zod'

import { mergeVisibleAppZoneOrder } from '../../project'
import { p } from '../trpc'

export default p
	.input(
		z.object({
			currentZoneIds: z.array(z.string()),
			visibleIds: z.array(z.string()),
			visibleCatalogIds: z.array(z.string())
		})
	)
	.query(({ input }) => mergeVisibleAppZoneOrder(input.currentZoneIds, input.visibleIds, input.visibleCatalogIds))
