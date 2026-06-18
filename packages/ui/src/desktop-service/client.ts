import { inject, InjectionToken, makeEnvironmentProviders } from '@angular/core'
import { createTRPCClient } from '@trpc/client'
import { ipcLink } from 'erpc/renderer'

import type { Router } from '@desktop/rpc'
import type { CreateDesktopOptions, Desktop } from './types'

export const DESKTOP = new InjectionToken<Desktop>('DESKTOP')

/**
 * 创建 UI 到 desktop 的 ERPC client
 * @param options - 创建选项
 */
export function createDesktop(options: CreateDesktopOptions = {}) {
	if (typeof window === 'undefined' || !window.$erpc) {
		if (options.allowMissingBridge !== false) {
			return null
		}

		throw new Error('Desktop ERPC bridge is unavailable.')
	}

	return createTRPCClient<Router>({
		links: [ipcLink()]
	})
}

/**
 * 注册全局 desktop ERPC 句柄 provider
 * @param options - 创建选项
 */
export function provideDesktop(options: CreateDesktopOptions = {}) {
	return makeEnvironmentProviders([
		{
			provide: DESKTOP,
			useFactory: () => createDesktop(options)
		}
	])
}

/**
 * 在 Angular 注入上下文中读取 desktop ERPC client
 */
export const injectDesktop = () => inject(DESKTOP)
