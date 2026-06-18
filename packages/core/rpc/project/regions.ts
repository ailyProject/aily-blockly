import { z } from 'zod'

import {
	getCurrentApiServer,
	getCurrentNpmRegistry,
	getCurrentResourceUrl,
	getCurrentUcenterWebUrl,
	getCurrentUpdaterUrl,
	getCurrentWebUrl,
	getEnabledRegionList,
	normalizeBuildFlavor,
	resolveOfficialRegionKey
} from '../../project'
import { p } from '../trpc'

const regionConfigSchema = z.object({
	/** 资源服务地址 */
	resource: z.string().optional(),
	/** npm registry 地址 */
	npm_registry: z.string().optional(),
	/** API 服务地址 */
	api_server: z.string().optional(),
	/** 工具 Web 地址 */
	tool_web: z.string().optional(),
	/** 更新器地址 */
	updater: z.string().optional(),
	/** Web 站点地址 */
	web: z.string().optional(),
	/** 用户中心地址 */
	ucenter_web: z.string().optional(),
	/** 区域展示名称 */
	name: z.string().optional(),
	/** 是否为官方区域 */
	official: z.boolean().optional(),
	/** 是否启用 */
	enabled: z.boolean().optional()
})

export const resolveRegions = p
	.input(
		z.object({
			regions: z.record(z.string(), regionConfigSchema).optional(),
			regionKey: z.string().optional(),
			officialRegion: z.string().optional(),
			buildFlavor: z.string().optional(),
			defaultBuildFlavor: z.string(),
			defaultOfficialRegion: z.string(),
			fallbackRegionKey: z.string(),
			fallbackWeb: z.string().optional(),
			fallbackUcenterWeb: z.string().optional(),
			currentSourceUrl: z.string().nullable().optional()
		})
	)
	.query(({ input }) => {
		const officialRegionKey = resolveOfficialRegionKey(input)

		return {
			buildFlavor: normalizeBuildFlavor(input.buildFlavor, input.defaultBuildFlavor),
			officialRegionKey,
			resourceUrl: getCurrentResourceUrl(input),
			npmRegistry: getCurrentNpmRegistry(input.regions, input.regionKey, input.fallbackRegionKey),
			apiServer: getCurrentApiServer(input.regions, input.regionKey, input.fallbackRegionKey),
			updaterUrl: getCurrentUpdaterUrl(input.regions, input.regionKey, input.fallbackRegionKey),
			webUrl: getCurrentWebUrl(input),
			ucenterWebUrl: getCurrentUcenterWebUrl(input),
			enabledRegions: getEnabledRegionList({ regions: input.regions, officialRegionKey })
		}
	})
