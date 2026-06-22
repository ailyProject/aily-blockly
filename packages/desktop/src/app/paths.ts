import path from 'node:path'

import type { DesktopAppLaunchOptions } from './types'

const DEFAULT_UI_DEV_SERVER_URL = 'http://127.0.0.1:4200'

/**
 * 解析当前 desktop 主进程使用的 preload 文件路径。
 */
export const resolveDesktopPreloadPath = () => path.resolve(__dirname, '../preload/index.js')

/**
 * 解析当前桌面壳在生产态回退使用的 UI `index.html` 路径。
 * @param options - 启动参数
 */
export const resolveDesktopUiIndexHtmlPath = (options: DesktopAppLaunchOptions = {}) =>
	options.indexHtmlPath || path.resolve(__dirname, '../../../ui/dist/ui/browser/index.html')

/**
 * 解析当前桌面壳优先加载的 UI 地址。
 * @param options - 启动参数
 */
export const resolveDesktopUiUrl = (options: DesktopAppLaunchOptions = {}) =>
	options.devServerUrl || process.env['AILY_UI_DEV_SERVER_URL'] || DEFAULT_UI_DEV_SERVER_URL
