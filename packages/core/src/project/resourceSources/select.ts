import type { ResourceSourceConfig } from '../types'

/**
 * 判断是否为自动资源源选择
 * @param selectedKey - 当前选择键
 */
export const isAutoResourceSourceSelection = (selectedKey: string) => selectedKey === 'auto'

/**
 * 获取手动选择的资源源
 * @param sources - 可用资源源列表
 * @param selectedKey - 当前选择键
 */
export const getManualResourceSource = (sources: Array<ResourceSourceConfig>, selectedKey: string) => {
	if (selectedKey === 'auto') return null
	return sources.find(source => source.key === selectedKey) || null
}

/**
 * 获取当前生效的资源源
 * @param sources - 可用资源源列表
 * @param selectedKey - 当前选择键
 * @param activeResourceSourceKey - 当前活跃资源源键
 */
export const getCurrentResourceSource = (
	sources: Array<ResourceSourceConfig>,
	selectedKey: string,
	activeResourceSourceKey?: string | null
) => {
	if (sources.length === 0) return null
	if (!isAutoResourceSourceSelection(selectedKey)) {
		return getManualResourceSource(sources, selectedKey) || sources[0]
	}

	return sources.find(source => source.key === activeResourceSourceKey) || sources[0]
}
