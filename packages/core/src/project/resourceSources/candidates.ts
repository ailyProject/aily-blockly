import { getCurrentResourceSource, getManualResourceSource, isAutoResourceSourceSelection } from './select'

import type { ResourceRuntimeEnvPayload, ResourceSourceConfig } from '../types'

/**
 * 获取资源源候选顺序
 * @param sources - 可用资源源列表
 * @param selectedKey - 当前选择键
 * @param activeResourceSourceKey - 当前活跃资源源键
 */
export const getResourceSourceCandidates = (
	sources: Array<ResourceSourceConfig>,
	selectedKey: string,
	activeResourceSourceKey?: string | null
) => {
	if (sources.length === 0) return []
	if (!isAutoResourceSourceSelection(selectedKey)) {
		return [getManualResourceSource(sources, selectedKey) || sources[0]]
	}

	const currentSource = getCurrentResourceSource(sources, selectedKey, activeResourceSourceKey)
	if (!currentSource) return sources

	return [currentSource, ...sources.filter(source => source.key !== currentSource.key)]
}

/**
 * 构建资源 zip URL 候选列表
 * @param candidates - 资源源候选列表
 */
export const buildZipUrlCandidates = (candidates: Array<ResourceSourceConfig>) => {
	const seenUrls = new Set<string>()
	const urls: Array<string> = []

	for (const source of candidates) {
		if (!source.url || seenUrls.has(source.url)) continue
		seenUrls.add(source.url)
		urls.push(source.url)
	}

	return urls
}

/**
 * 构建资源源运行时环境变量载荷。
 * @param currentUrl - 当前生效资源地址
 * @param candidates - 资源源候选列表
 */
export const buildResourceRuntimeEnvPayload = (
	currentUrl: string,
	candidates: Array<ResourceSourceConfig>
): ResourceRuntimeEnvPayload => ({
	AILY_ZIP_URL: currentUrl,
	AILY_ZIP_URLS: JSON.stringify(buildZipUrlCandidates(candidates))
})
