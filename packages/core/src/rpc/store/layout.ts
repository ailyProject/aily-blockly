import { HEADER_APP_LIMIT, TOOLBAR_APP_IDS_CONFIG_KEY } from '@shared'
import { z } from 'zod'

import {
	addLayoutApp,
	createDefaultAppStoreLayout,
	isAppVisibleInContext,
	mergeVisibleAppZoneOrder,
	normalizeAppStoreLayout,
	readToolbarAppIdsFromConfig,
	removeLayoutApp,
	resetLayout,
	sanitizeAppZoneIds,
	setLayoutZoneApps,
	toggleLayoutApp
} from '../../project'
import { appConfigInputSchema, appRegistryItemSchema } from '../config/schemas'
import { p } from '../trpc'

export const resolveLayout = p
	.input(
		z.object({
			config: appConfigInputSchema.optional(),
			apps: z.array(appRegistryItemSchema),
			defaultToolbarAppIds: z.array(z.string()).optional(),
			context: z
				.object({
					routeUrl: z.string().optional(),
					boardCore: z.string().optional(),
					isDevMode: z.boolean().optional()
				})
				.optional()
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

export const createDefaultLayout = p
	.input(z.object({ defaultToolbarAppIds: z.array(z.string()), apps: z.array(appRegistryItemSchema) }))
	.query(({ input }) =>
		createDefaultAppStoreLayout(input.defaultToolbarAppIds, new Map(input.apps.map(app => [app.id, app])))
	)

export const mergeVisibleOrder = p
	.input(
		z.object({
			currentZoneIds: z.array(z.string()),
			visibleIds: z.array(z.string()),
			visibleCatalogIds: z.array(z.string())
		})
	)
	.query(({ input }) => mergeVisibleAppZoneOrder(input.currentZoneIds, input.visibleIds, input.visibleCatalogIds))

export const setLayout = p
	.input(
		z.object({
			layout: z.object({ version: z.literal(2), zones: z.object({ header: z.array(z.string()) }) }),
			zone: z.enum(['header']),
			appIds: z.array(z.string()),
			apps: z.array(appRegistryItemSchema)
		})
	)
	.query(({ input }) =>
		setLayoutZoneApps(input.layout, input.zone, input.appIds, new Map(input.apps.map(app => [app.id, app])))
	)

export const addApp = p
	.input(
		z.object({
			layout: z.object({ version: z.literal(2), zones: z.object({ header: z.array(z.string()) }) }),
			zone: z.enum(['header']),
			appId: z.string(),
			apps: z.array(appRegistryItemSchema)
		})
	)
	.query(({ input }) =>
		addLayoutApp(input.layout, input.zone, input.appId, new Map(input.apps.map(app => [app.id, app])))
	)

export const removeApp = p
	.input(
		z.object({
			layout: z.object({ version: z.literal(2), zones: z.object({ header: z.array(z.string()) }) }),
			zone: z.enum(['header']),
			appId: z.string(),
			apps: z.array(appRegistryItemSchema)
		})
	)
	.query(({ input }) =>
		removeLayoutApp(input.layout, input.zone, input.appId, new Map(input.apps.map(app => [app.id, app])))
	)

export const toggleApp = p
	.input(
		z.object({
			layout: z.object({ version: z.literal(2), zones: z.object({ header: z.array(z.string()) }) }),
			zone: z.enum(['header']),
			appId: z.string(),
			apps: z.array(appRegistryItemSchema)
		})
	)
	.query(({ input }) =>
		toggleLayoutApp(input.layout, input.zone, input.appId, new Map(input.apps.map(app => [app.id, app])))
	)

export const reset = p
	.input(z.object({ defaultToolbarAppIds: z.array(z.string()), apps: z.array(appRegistryItemSchema) }))
	.query(({ input }) => resetLayout(input.defaultToolbarAppIds, new Map(input.apps.map(app => [app.id, app]))))
