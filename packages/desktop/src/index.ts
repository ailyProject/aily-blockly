import { createIPCHandler } from 'erpc/main'

import { createDesktopCoreServiceManager } from './core-service'
import { routers } from './rpc'

import type { BootstrapDesktopMainOptions, BootstrapDesktopMainResult, DesktopMainContext } from './types'

export * from './core-service'
export * from './rpc'
export * from './types'

/**
 * Electron 主进程薄壳入口
 * @param options - bootstrap 选项
 */
export const bootstrapDesktopMain = (options: BootstrapDesktopMainOptions = {}): BootstrapDesktopMainResult => {
	const coreService = options.coreService ?? createDesktopCoreServiceManager({ transport: 'utility-process' })
	const handler = createIPCHandler({
		router: routers,
		windows: options.windows ?? [],
		createContext: async ({ event }) => {
			const baseContext: DesktopMainContext = {
				coreService,
				event
			}

			const extension = (await options.createContext?.(baseContext)) ?? {}
			return {
				...baseContext,
				...extension
			}
		}
	})

	return {
		coreService,
		router: routers,
		handler
	}
}
