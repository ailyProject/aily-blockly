import { z } from 'zod'

import {
	addRecentlyProject,
	buildProjectDirectoryPath,
	getCurrentApiServer,
	getCurrentNpmRegistry,
	getCurrentResourceUrl,
	getCurrentUcenterWebUrl,
	getCurrentUpdaterUrl,
	getCurrentWebUrl,
	getDefaultProjectRootPath,
	getEnabledRegionList,
	isSameProjectPath,
	normalizeBuildFlavor,
	removeRecentlyProject,
	resolveOfficialRegionKey,
	resolveProjectRootPath
} from '../project'
import { p, r } from './trpc'

const recentProjectEntrySchema = z.object({
	/** 项目主名称 */
	name: z.string(),
	/** 项目绝对路径 */
	path: z.string(),
	/** 可选展示昵称 */
	nickname: z.string().optional()
})

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

/**
 * 暴露项目配置与区域选择纯规则
 */
export default r({
	addRecentlyProject: p
		.input(
			z.object({
				current: z.array(recentProjectEntrySchema),
				entry: recentProjectEntrySchema,
				maxSize: z.number().optional()
			})
		)
		.query(({ input }) => addRecentlyProject(input.current, input.entry, input.maxSize)),
	removeRecentlyProject: p
		.input(z.object({ current: z.array(recentProjectEntrySchema), path: z.string() }))
		.query(({ input }) => removeRecentlyProject(input.current, input.path)),
	resolveProjectPath: p
		.input(
			z.object({
				basePath: z.string(),
				name: z.string(),
				separator: z.string()
			})
		)
		.query(({ input }) => buildProjectDirectoryPath(input.basePath, input.name, input.separator)),
	resolveProjectRootPath: p
		.input(
			z.object({
				template: z.string(),
				userDocuments: z.string(),
				separator: z.string()
			})
		)
		.query(({ input }) => resolveProjectRootPath(input.template, input.userDocuments, input.separator)),
	getDefaultProjectRootPath: p
		.input(
			z.object({
				userDocuments: z.string(),
				separator: z.string()
			})
		)
		.query(({ input }) => getDefaultProjectRootPath(input.userDocuments, input.separator)),
	isSameProjectPath: p
		.input(
			z.object({
				leftPath: z.string().optional(),
				rightPath: z.string().optional()
			})
		)
		.query(({ input }) => isSameProjectPath(input.leftPath, input.rightPath)),
	resolveRegions: p
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
})
