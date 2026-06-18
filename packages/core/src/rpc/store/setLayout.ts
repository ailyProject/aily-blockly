import { z } from 'zod'

import { setLayoutZoneApps } from '../../project'
import { p } from '../trpc'
import { appRegistryItemSchema, appStoreLayoutSchema } from './schemas'

export default p
	.input(
		z.object({
			layout: appStoreLayoutSchema,
			zone: z.enum(['header']),
			appIds: z.array(z.string()),
			apps: z.array(appRegistryItemSchema)
		})
	)
	.query(({ input }) =>
		setLayoutZoneApps(input.layout, input.zone, input.appIds, new Map(input.apps.map(app => [app.id, app])))
	)
