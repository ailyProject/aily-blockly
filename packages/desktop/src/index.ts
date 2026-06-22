import { app } from 'electron'
import { createIPCHandler } from 'erpc/main'

import { createDesktopBleBridge } from './ble'
import { createDesktopCoreServiceManager } from './core-service'
import { registerDesktopProjectOpenEvents } from './project-open'
import { default as rpc } from './rpc'
import { createDesktopTerminalManager } from './terminal'

import type { BootstrapDesktopMainOptions, BootstrapDesktopMainResult, DesktopMainContext } from './types'

export * from './core-service'
export * from './rpc'
export * from './ble'
export * from './project-open'
export * from './terminal'
export * from './types'
export type { Router } from './rpc/types'

/**
 * Electron 主进程薄壳入口
 * @param options - bootstrap 选项
 */
export const bootstrapDesktopMain = (options: BootstrapDesktopMainOptions = {}): BootstrapDesktopMainResult => {
	const coreService = options.coreService ?? createDesktopCoreServiceManager({ transport: 'utility-process' })
	const terminalManager = options.terminalManager ?? createDesktopTerminalManager()
	const bleBridge = createDesktopBleBridge()
	registerDesktopProjectOpenEvents(options.app ?? app)
	bleBridge.registerHandlers()
	for (const window of options.windows ?? []) {
		bleBridge.registerChooser(window)
	}
	const handler = createIPCHandler({
		router: rpc,
		windows: options.windows ?? [],
		createContext: async ({ event }) => {
			const baseContext: DesktopMainContext = {
				coreService,
				bleBridge,
				terminalManager,
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
		bleBridge,
		terminalManager,
		router: rpc,
		handler
	}
}
