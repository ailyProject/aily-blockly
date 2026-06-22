import { createTRPCClient, httpBatchLink } from '@trpc/client'
import { createAilyCoreServiceAddress } from 'shared'

import type { Router } from '@core'
import type { Core, CoreWindowConfig, CreateCoreOptions } from './core.types'

export type {
	Core,
	CoreWindowConfig,
	CreateCoreOptions,
	LoadHomePreviewContext,
	LoadHomePreviewOptions
} from './core.types'
export { loadHomePreview } from './home-preview'
let coreSingleton: Core | null = null

/**
 * 解析 UI 当前应连接到的 Core 服务根地址。
 * @param options - 显式传入的地址覆盖项。
 */
export const resolveCoreBaseUrl = (options: CreateCoreOptions = {}) => {
	if (options.baseUrl) return options.baseUrl

	const windowConfig = typeof window !== 'undefined' ? window.__AILY_CORE__ : undefined
	if (windowConfig?.baseUrl) return windowConfig.baseUrl

	return createAilyCoreServiceAddress({
		host: options.address?.host ?? windowConfig?.host,
		port: options.address?.port ?? windowConfig?.port
	}).baseUrl
}

/**
 * 把 desktop / runtime 返回的 core 地址写回到浏览器全局配置。
 * @param config - 要写入的地址覆盖项。
 */
export const assignCoreWindowConfig = (config: CoreWindowConfig) => {
	if (typeof window === 'undefined') return

	window.__AILY_CORE__ = {
		...(window.__AILY_CORE__ ?? {}),
		...config
	}
}

/**
 * 创建 UI 到 Core 的 tRPC 句柄。
 * @param options - 地址解析选项。
 */
export function createCore(options: CreateCoreOptions = {}) {
	return createTRPCClient<Router>({
		links: [
			httpBatchLink({
				url: `${resolveCoreBaseUrl(options)}/trpc`
			})
		]
	})
}

/**
 * 读取 UI 全局共享的 Core tRPC 句柄。
 * @param options - 地址解析选项。
 */
export const getCore = (options: CreateCoreOptions = {}) => {
	if (!coreSingleton || options.baseUrl || options.address) {
		coreSingleton = createCore(options)
	}
	return coreSingleton
}
