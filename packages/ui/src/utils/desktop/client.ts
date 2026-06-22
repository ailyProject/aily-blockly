import { createTRPCClient } from '@trpc/client'
import { ipcLink } from 'erpc/renderer'

import type { Router } from '@desktop'
import type { CreateDesktopOptions, Desktop } from './types'

let desktopSingleton: Desktop | null | undefined

/**
 * 创建 UI 到 desktop 的 ERPC 句柄。
 * @param options - 创建选项。
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
 * 读取 UI 全局共享的 desktop ERPC 句柄。
 * @param options - 创建选项。
 */
export const getDesktop = (options: CreateDesktopOptions = {}) => {
	if (desktopSingleton === undefined || options.allowMissingBridge === false) {
		desktopSingleton = createDesktop(options)
	}
	return desktopSingleton ?? null
}
