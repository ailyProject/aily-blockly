import { getCurrentRegionConfig } from './base'

import type { RegionConfigMap } from '../types'

const trimTrailingSlash = (url: string) => (url.endsWith('/') ? url.slice(0, -1) : url)

/**
 * 获取当前区域资源 URL
 * @param input - 输入参数
 */
export const getCurrentResourceUrl = (input: {
	currentSourceUrl?: string | null
	regions?: RegionConfigMap
	regionKey?: string
	fallbackRegionKey: string
}) => {
	const regionConfig = getCurrentRegionConfig(input.regions, input.regionKey, input.fallbackRegionKey)
	return input.currentSourceUrl || regionConfig?.resource || ''
}

/**
 * 获取当前区域 NPM Registry
 * @param regions - 区域配置映射
 * @param regionKey - 当前区域键
 * @param fallbackRegionKey - 兜底区域键
 */
export const getCurrentNpmRegistry = (
	regions: RegionConfigMap | undefined,
	regionKey: string | undefined,
	fallbackRegionKey: string
) => getCurrentRegionConfig(regions, regionKey, fallbackRegionKey)?.npm_registry || ''

/**
 * 获取当前区域 API Server
 * @param regions - 区域配置映射
 * @param regionKey - 当前区域键
 * @param fallbackRegionKey - 兜底区域键
 */
export const getCurrentApiServer = (
	regions: RegionConfigMap | undefined,
	regionKey: string | undefined,
	fallbackRegionKey: string
) => getCurrentRegionConfig(regions, regionKey, fallbackRegionKey)?.api_server || ''

/**
 * 获取当前区域更新器地址
 * @param regions - 区域配置映射
 * @param regionKey - 当前区域键
 * @param fallbackRegionKey - 兜底区域键
 */
export const getCurrentUpdaterUrl = (
	regions: RegionConfigMap | undefined,
	regionKey: string | undefined,
	fallbackRegionKey: string
) => getCurrentRegionConfig(regions, regionKey, fallbackRegionKey)?.updater || ''

/**
 * 获取当前 Web 站点地址
 * @param input - 输入参数
 */
export const getCurrentWebUrl = (input: {
	regions?: RegionConfigMap
	regionKey?: string
	fallbackRegionKey: string
	fallbackWeb?: string
}) => {
	const url =
		getCurrentRegionConfig(input.regions, input.regionKey, input.fallbackRegionKey)?.web ||
		input.fallbackWeb ||
		'https://aily.pro'
	return trimTrailingSlash(url)
}

/**
 * 获取当前用户中心地址
 * @param input - 输入参数
 */
export const getCurrentUcenterWebUrl = (input: {
	regions?: RegionConfigMap
	regionKey?: string
	fallbackRegionKey: string
	fallbackUcenterWeb?: string
}) => {
	const url =
		getCurrentRegionConfig(input.regions, input.regionKey, input.fallbackRegionKey)?.ucenter_web ||
		input.fallbackUcenterWeb ||
		'https://c.aily.pro'
	return trimTrailingSlash(url)
}
