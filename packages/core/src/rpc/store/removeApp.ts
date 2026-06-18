import { z } from 'zod'

import { removeLayoutApp } from '../../project'
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
		removeLayoutApp(input.layout, input.zone, input.appId, new Map(input.apps.map(app => [app.id, app])))
	)
