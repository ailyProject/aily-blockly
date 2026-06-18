import { z } from 'zod'

import { toggleLayoutApp } from '../../project'
import { p } from '../trpc'
import { appRegistryItemSchema, appStoreLayoutSchema } from './schemas'

export default p
	.input(
		z.object({
			layout: appStoreLayoutSchema,
			zone: z.enum(['header']),
			appId: z.string(),
			apps: z.array(appRegistryItemSchema)
		})
	)
	.query(({ input }) =>
		toggleLayoutApp(input.layout, input.zone, input.appId, new Map(input.apps.map(app => [app.id, app])))
	)
