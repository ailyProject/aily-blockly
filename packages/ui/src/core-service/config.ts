import { createAilyCoreServiceAddress } from 'shared'

import type { CoreServiceWindowConfig, CreateCoreOptions } from './types'

/**
 * 解析 UI 当前应连接到的 Core 服务根地址
 * @param options - 显式传入的地址覆盖项
 */
export const resolveCoreServiceBaseUrl = (options: CreateCoreOptions = {}) => {
	if (options.baseUrl) return options.baseUrl

	const windowConfig = typeof window !== 'undefined' ? window.__AILY_CORE_SERVICE__ : undefined
	if (windowConfig?.baseUrl) return windowConfig.baseUrl

	return createAilyCoreServiceAddress({
		host: options.address?.host ?? windowConfig?.host,
		port: options.address?.port ?? windowConfig?.port
	}).baseUrl
}

/**
 * 把 desktop / runtime 返回的 core service 地址写回到浏览器全局配置
 * @param config - 要写入的地址覆盖项
 */
export const assignCoreServiceWindowConfig = (config: CoreServiceWindowConfig) => {
	if (typeof window === 'undefined') return

	window.__AILY_CORE_SERVICE__ = {
		...(window.__AILY_CORE_SERVICE__ ?? {}),
		...config
	}
}
