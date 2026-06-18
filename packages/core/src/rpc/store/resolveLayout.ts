import { HEADER_APP_LIMIT, TOOLBAR_APP_IDS_CONFIG_KEY } from 'shared'
import { z } from 'zod'

import {
	isAppVisibleInContext,
	normalizeAppStoreLayout,
	readToolbarAppIdsFromConfig,
	sanitizeAppZoneIds
} from '../../project'
import { appConfigInputSchema } from '../config/schemas'
import { p } from '../trpc'
import { appRegistryItemSchema, appVisibilityContextSchema } from './schemas'

export default p
	.input(
		z.object({
			config: appConfigInputSchema.optional(),
			apps: z.array(appRegistryItemSchema),
			defaultToolbarAppIds: z.array(z.string()).optional(),
			context: appVisibilityContextSchema
		})
	)
	.query(({ input }) => {
		const appMap = new Map(input.apps.map(app => [app.id, app]))
		const storedToolbarIds = readToolbarAppIdsFromConfig(input.config, TOOLBAR_APP_IDS_CONFIG_KEY)
		const layout = normalizeAppStoreLayout(
			{
				version: 2,
				zones: {
					header: sanitizeAppZoneIds(
						'header',
						storedToolbarIds ?? input.defaultToolbarAppIds ?? [],
						HEADER_APP_LIMIT,
						appMap
					)
				}
			},
			HEADER_APP_LIMIT,
			appMap
		)

		return {
			layout,
			visibleHeaderIds: layout.zones.header.filter(appId => {
				const app = appMap.get(appId)
				return app ? isAppVisibleInContext(app, input.context) : false
			})
		}
	})
