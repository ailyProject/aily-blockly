import { inject, InjectionToken, makeEnvironmentProviders } from '@angular/core'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

import { resolveCoreServiceBaseUrl } from './config'

import type { Router } from '@core'
import type { Core, CreateCoreOptions } from './types'

export const CORE = new InjectionToken<Core>('CORE')

/**
 * 创建 UI 到 Core 的 tRPC client
 * @param options - 地址解析选项
 */
export function createCore(options: CreateCoreOptions = {}) {
	return createTRPCClient<Router>({
		links: [
			httpBatchLink({
				url: `${resolveCoreServiceBaseUrl(options)}/trpc`
			})
		]
	})
}

/**
 * 注册全局 Core tRPC 句柄 provider
 * @param options - 地址解析选项
 */
export function provideCore(options: CreateCoreOptions = {}) {
	return makeEnvironmentProviders([
		{
			provide: CORE,
			useFactory: () => createCore(options)
		}
	])
}

/**
 * 在 Angular 注入上下文中读取 Core tRPC client
 */
export const injectCore = () => inject(CORE)
