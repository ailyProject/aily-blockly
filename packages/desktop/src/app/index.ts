import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app } from 'electron'

import { bootstrapDesktopMain } from '../bootstrap'
import { resetDesktopStartupLog, writeDesktopStartupLog } from './log'
import {
	attachDesktopWindowDebugLogging,
	createDesktopMainWindow,
	loadDesktopMainWindow,
	logDesktopWindowState,
	presentDesktopMainWindow
} from './window'

import type { BootstrapDesktopMainResult } from '../types'
import type { DesktopAppLaunchOptions } from './types'

let desktopMainWindow: ReturnType<typeof createDesktopMainWindow> | null = null
let desktopMainRuntime: BootstrapDesktopMainResult | null = null
const execFileAsync = promisify(execFile)
let desktopWindowCreationLoggingAttached = false

/**
 * 在 macOS 上强制把当前桌面应用切到前台。
 * @param appName - 当前应用名
 */
const activateDesktopAppOnMac = async (appName: string) => {
	if (process.platform !== 'darwin') return

	try {
		await execFileAsync('/usr/bin/osascript', ['-e', `tell application "${appName}" to activate`], {
			encoding: 'utf8'
		})
		writeDesktopStartupLog(`[desktop-app] osascript-activate ${appName}`)
	} catch (error) {
		writeDesktopStartupLog(
			`[desktop-app] osascript-activate-failed ${error instanceof Error ? error.message : String(error)}`
		)
	}
}

/**
 * 记录当前 Electron 进程里所有窗口创建事件。
 */
const attachDesktopWindowCreationLogging = () => {
	if (desktopWindowCreationLoggingAttached) return
	desktopWindowCreationLoggingAttached = true

	app.on('browser-window-created', (_event, window) => {
		writeDesktopStartupLog(
			`[desktop-app] browser-window-created ${JSON.stringify({
				id: window.id,
				title: window.getTitle(),
				bounds: window.getBounds()
			})}`
		)

		window.on('closed', () => {
			writeDesktopStartupLog(`[desktop-app] browser-window-closed ${window.id}`)
		})

		window.webContents.on('did-finish-load', () => {
			writeDesktopStartupLog(
				`[desktop-app] browser-window-created-did-finish-load ${JSON.stringify({
					id: window.id,
					title: window.getTitle(),
					url: window.webContents.getURL()
				})}`
			)
		})
	})

	app.on('web-contents-created', (_event, webContents) => {
		writeDesktopStartupLog(
			`[desktop-app] web-contents-created ${JSON.stringify({
				id: webContents.id,
				type: webContents.getType()
			})}`
		)
	})
}

/**
 * 启动 Electron 桌面应用。
 * @param options - 启动参数
 */
export const launchDesktopApp = async (options: DesktopAppLaunchOptions = {}) => {
	resetDesktopStartupLog()
	writeDesktopStartupLog('[desktop-app] launch-start')
	attachDesktopWindowCreationLogging()
	const gotSingleInstanceLock = app.requestSingleInstanceLock()
	writeDesktopStartupLog(`[desktop-app] single-instance-lock ${gotSingleInstanceLock ? 'granted' : 'rejected'}`)
	if (!gotSingleInstanceLock) {
		app.quit()
		return
	}
	await app.whenReady()
	writeDesktopStartupLog('[desktop-app] app-ready')
	if (typeof app.setActivationPolicy === 'function') {
		app.setActivationPolicy('regular')
		writeDesktopStartupLog('[desktop-app] activation-policy-regular')
	}
	app.setName('Aily Blockly')
	writeDesktopStartupLog(`[desktop-app] app-name ${app.getName()}`)
	if (app.dock && typeof app.dock.show === 'function') {
		app.dock.show()
		writeDesktopStartupLog('[desktop-app] dock-show')
	}
	app.focus({ steal: true })
	await activateDesktopAppOnMac(app.getName())
	writeDesktopStartupLog('[desktop-app] app-focus')

	const mainWindow = createDesktopMainWindow()
	desktopMainWindow = mainWindow
	writeDesktopStartupLog('[desktop-app] main-window-created')
	writeDesktopStartupLog(`[desktop-app] main-window-id ${mainWindow.id}`)
	attachDesktopWindowDebugLogging(mainWindow)
	mainWindow.webContents.on('did-finish-load', () => {
		writeDesktopStartupLog('[desktop-app] webcontents-did-finish-load')
		presentDesktopMainWindow(mainWindow)
		logDesktopWindowState(mainWindow, 'after-load')
		void activateDesktopAppOnMac(app.getName())
	})

	desktopMainRuntime ??= bootstrapDesktopMain({
		app,
		windows: [mainWindow]
	})
	writeDesktopStartupLog('[desktop-app] desktop-main-bootstrapped')
	desktopMainRuntime.handler.attachWindow(mainWindow)
	writeDesktopStartupLog('[desktop-app] handler-attach-window')
	mainWindow.on('closed', () => {
		desktopMainWindow = null
		writeDesktopStartupLog('[desktop-app] main-window-cleared')
	})

	await loadDesktopMainWindow(mainWindow, options)
	writeDesktopStartupLog('[desktop-app] main-window-load-complete')

	app.on('activate', async () => {
		writeDesktopStartupLog('[desktop-app] app-activate')
		if (desktopMainWindow) {
			desktopMainWindow.show()
			desktopMainWindow.focus()
			await activateDesktopAppOnMac(app.getName())
			writeDesktopStartupLog('[desktop-app] existing-window-focused')
			return
		}

		const nextWindow = createDesktopMainWindow()
		desktopMainWindow = nextWindow
		writeDesktopStartupLog('[desktop-app] next-window-created')
		writeDesktopStartupLog(`[desktop-app] next-window-id ${nextWindow.id}`)
		attachDesktopWindowDebugLogging(nextWindow)
		nextWindow.webContents.on('did-finish-load', () => {
			writeDesktopStartupLog('[desktop-app] next-webcontents-did-finish-load')
			presentDesktopMainWindow(nextWindow)
			logDesktopWindowState(nextWindow, 'next-after-load')
			void activateDesktopAppOnMac(app.getName())
		})
		desktopMainRuntime?.handler.attachWindow(nextWindow)
		desktopMainRuntime?.bleBridge.registerChooser(nextWindow)
		writeDesktopStartupLog('[desktop-app] next-window-attached')
		nextWindow.on('closed', () => {
			desktopMainWindow = null
			writeDesktopStartupLog('[desktop-app] next-window-cleared')
		})
		await loadDesktopMainWindow(nextWindow, options)
		writeDesktopStartupLog('[desktop-app] next-window-load-complete')
	})

	app.on('second-instance', () => {
		writeDesktopStartupLog('[desktop-app] second-instance')
		if (!desktopMainWindow) return

		presentDesktopMainWindow(desktopMainWindow)
		void activateDesktopAppOnMac(app.getName())
	})

	app.on('window-all-closed', () => {
		writeDesktopStartupLog('[desktop-app] window-all-closed')
		if (process.platform !== 'darwin') {
			void app.quit()
		}
	})
}
