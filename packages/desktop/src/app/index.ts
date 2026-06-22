import { app } from 'electron'

import { bootstrapDesktopMain } from '../bootstrap'
import { createDesktopMainWindow, loadDesktopMainWindow } from './window'

import type { BootstrapDesktopMainResult } from '../types'
import type { DesktopAppLaunchOptions } from './types'

let desktopMainWindow: ReturnType<typeof createDesktopMainWindow> | null = null
let desktopMainRuntime: BootstrapDesktopMainResult | null = null

/**
 * 启动 Electron 桌面应用。
 * @param options - 启动参数
 */
export const launchDesktopApp = async (options: DesktopAppLaunchOptions = {}) => {
	await app.whenReady()

	const mainWindow = createDesktopMainWindow()
	desktopMainWindow = mainWindow

	desktopMainRuntime ??= bootstrapDesktopMain({
		app,
		windows: [mainWindow]
	})
	desktopMainRuntime.handler.attachWindow(mainWindow)

	mainWindow.once('ready-to-show', () => {
		mainWindow.show()
	})
	mainWindow.on('closed', () => {
		desktopMainWindow = null
	})

	await loadDesktopMainWindow(mainWindow, options)

	app.on('activate', async () => {
		if (desktopMainWindow) {
			desktopMainWindow.show()
			desktopMainWindow.focus()
			return
		}

		const nextWindow = createDesktopMainWindow()
		desktopMainWindow = nextWindow
		desktopMainRuntime?.handler.attachWindow(nextWindow)
		desktopMainRuntime?.bleBridge.registerChooser(nextWindow)
		nextWindow.once('ready-to-show', () => {
			nextWindow.show()
		})
		nextWindow.on('closed', () => {
			desktopMainWindow = null
		})
		await loadDesktopMainWindow(nextWindow, options)
	})

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') {
			void app.quit()
		}
	})
}
