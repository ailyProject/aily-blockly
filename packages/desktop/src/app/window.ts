import fs from 'node:fs'
import { BrowserWindow } from 'electron'

import { resolveDesktopPreloadPath, resolveDesktopUiIndexHtmlPath, resolveDesktopUiUrl } from './paths'

import type { DesktopAppLaunchOptions } from './types'

/**
 * 创建主工作台窗口。
 */
export const createDesktopMainWindow = () =>
	new BrowserWindow({
		width: 1440,
		height: 920,
		minWidth: 1120,
		minHeight: 720,
		show: false,
		title: 'Aily Blockly',
		backgroundColor: '#f6f5ef',
		webPreferences: {
			preload: resolveDesktopPreloadPath(),
			contextIsolation: true,
			nodeIntegration: false
		}
	})

/**
 * 把前端页面加载到指定窗口。
 * @param window - 目标窗口
 * @param options - 启动参数
 */
export const loadDesktopMainWindow = async (window: BrowserWindow, options: DesktopAppLaunchOptions = {}) => {
	const devServerUrl = resolveDesktopUiUrl(options)
	const indexHtmlPath = resolveDesktopUiIndexHtmlPath(options)

	try {
		await window.loadURL(devServerUrl)
		return
	} catch {
		if (!fs.existsSync(indexHtmlPath)) {
			throw new Error(`Desktop UI entry was not found: ${indexHtmlPath}`)
		}
		await window.loadFile(indexHtmlPath)
	}
}
