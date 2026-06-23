import { normalizeResourceSourceList, normalizeSelectedResourceSourceKey } from '../../resourceSources'

import type { AilyAppConfig, ResourceSourceConfig } from 'shared'

/**
 * 更新当前选中的区域。
 * @param config - 当前应用配置
 * @param region - 新区域键
 */
export const setRegion = (config: AilyAppConfig | null | undefined, region: string): AilyAppConfig => ({
	...(config ?? {}),
	region: region.trim()
})

/**
 * 更新当前选中的资源源键。
 * @param config - 当前应用配置
 * @param resourceSource - 新资源源键
 */
export const setResourceSource = (config: AilyAppConfig | null | undefined, resourceSource: string): AilyAppConfig => ({
	...(config ?? {}),
	resource_source: normalizeSelectedResourceSourceKey(resourceSource)
})

/**
 * 更新资源源列表。
 * @param config - 当前应用配置
 * @param resourceSources - 新资源源列表
 */
export const setResourceSources = (
	config: AilyAppConfig | null | undefined,
	resourceSources: Array<Partial<ResourceSourceConfig>>
): AilyAppConfig => ({
	...(config ?? {}),
	resource_sources: normalizeResourceSourceList(resourceSources, config?.regions)
})
