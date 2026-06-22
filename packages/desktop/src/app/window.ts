import fs from 'node:fs'
import { BrowserWindow } from 'electron'

import { writeDesktopStartupLog } from './log'
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
		show: true,
		title: 'Aily Blockly',
		backgroundColor: '#f6f5ef',
		webPreferences: {
			preload: resolveDesktopPreloadPath(),
			contextIsolation: true,
			nodeIntegration: false
		}
	})

/**
 * 给主窗口挂接最小运行态日志，便于确认窗口是否真正创建/显示。
 * @param window - 目标窗口
 */
export const attachDesktopWindowDebugLogging = (window: BrowserWindow) => {
	window.on('show', () => {
		console.log('[desktop-window] show')
		writeDesktopStartupLog('[desktop-window] show')
	})
	window.on('hide', () => {
		console.log('[desktop-window] hide')
		writeDesktopStartupLog('[desktop-window] hide')
	})
	window.on('focus', () => {
		console.log('[desktop-window] focus')
		writeDesktopStartupLog('[desktop-window] focus')
	})
	window.on('blur', () => {
		console.log('[desktop-window] blur')
		writeDesktopStartupLog('[desktop-window] blur')
	})
	window.on('closed', () => {
		console.log('[desktop-window] closed')
		writeDesktopStartupLog('[desktop-window] closed')
	})
	window.webContents.on('did-finish-load', () => {
		console.log('[desktop-window] did-finish-load', window.webContents.getURL())
		writeDesktopStartupLog(`[desktop-window] did-finish-load ${window.webContents.getURL()}`)
	})
	window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
		console.log(
			'[desktop-window] did-fail-load',
			JSON.stringify({ errorCode, errorDescription, validatedURL, isMainFrame })
		)
		writeDesktopStartupLog(
			`[desktop-window] did-fail-load ${JSON.stringify({ errorCode, errorDescription, validatedURL, isMainFrame })}`
		)
	})
	window.webContents.on('render-process-gone', (_event, details) => {
		console.log('[desktop-window] render-process-gone', JSON.stringify(details))
		writeDesktopStartupLog(`[desktop-window] render-process-gone ${JSON.stringify(details)}`)
	})
}

/**
 * 记录当前窗口可见性状态。
 * @param window - 目标窗口
 * @param label - 状态标签
 */
export const logDesktopWindowState = (window: BrowserWindow, label: string) => {
	writeDesktopStartupLog(
		`[desktop-window] state ${label} ${JSON.stringify({
			visible: window.isVisible(),
			focused: window.isFocused(),
			minimized: window.isMinimized(),
			destroyed: window.isDestroyed(),
			bounds: window.getBounds()
		})}`
	)
}

/**
 * 尽量确保窗口在当前桌面可见并获得焦点。
 * @param window - 目标窗口
 */
export const presentDesktopMainWindow = (window: BrowserWindow) => {
	writeDesktopStartupLog('[desktop-window] present-start')
	logDesktopWindowState(window, 'before-present')
	window.center()
	if (window.isMinimized()) {
		window.restore()
	}
	window.setAlwaysOnTop(true, 'screen-saver')
	window.show()
	if (typeof window.moveTop === 'function') {
		window.moveTop()
	}
	window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
	setTimeout(() => {
		if (!window.isDestroyed()) {
			window.setAlwaysOnTop(false)
			window.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true })
		}
	}, 5_000)
	window.focus()
	logDesktopWindowState(window, 'after-present')
	writeDesktopStartupLog('[desktop-window] present-finish')
}

/**
 * 在主窗口里渲染启动中的占位页。
 * @param window - 目标窗口
 */
export const renderDesktopLoadingPage = async (window: BrowserWindow) => {
	writeDesktopStartupLog('[desktop-window] loading-page-render-start')
	const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Aily Blockly</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: linear-gradient(160deg, #f6f5ef 0%, #ece9df 100%);
        color: #16202a;
        font-family: system-ui, sans-serif;
      }
      main {
        width: min(560px, calc(100vw - 48px));
        padding: 28px 32px;
        border-radius: 24px;
        background: rgba(255, 255, 255, 0.84);
        box-shadow: 0 18px 60px rgba(18, 29, 43, 0.14);
      }
      h1 {
        margin: 0 0 12px;
        font-size: 28px;
      }
      p {
        margin: 0;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Aily Blockly</h1>
      <p>Desktop shell is starting. Waiting for the workspace UI and core runtime to become ready.</p>
    </main>
  </body>
</html>`

	await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
	writeDesktopStartupLog('[desktop-window] loading-page-render-finish')
}

/**
 * 等待开发态前端服务可访问。
 * @param url - 前端 dev server 地址
 * @param timeoutMs - 最大等待时间
 */
const waitForDesktopUiDevServer = async (url: string, timeoutMs = 8_000): Promise<boolean> => {
	writeDesktopStartupLog(`[desktop-window] wait-dev-server-start ${url}`)
	const deadline = Date.now() + timeoutMs

	while (Date.now() < deadline) {
		try {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), 1_000)
			const response = await fetch(url, { signal: controller.signal })
			clearTimeout(timer)
			if (response.ok) {
				writeDesktopStartupLog(`[desktop-window] wait-dev-server-ready ${url}`)
				return true
			}
		} catch {
			// keep waiting for the dev server
		}

		await new Promise(resolve => setTimeout(resolve, 500))
	}

	writeDesktopStartupLog(`[desktop-window] wait-dev-server-timeout ${url}`)
	return false
}

/**
 * 把前端页面加载到指定窗口。
 * @param window - 目标窗口
 * @param options - 启动参数
 */
export const loadDesktopMainWindow = async (window: BrowserWindow, options: DesktopAppLaunchOptions = {}) => {
	const devServerUrl = resolveDesktopUiUrl(options)
	const indexHtmlPath = resolveDesktopUiIndexHtmlPath(options)

	if (await waitForDesktopUiDevServer(devServerUrl)) {
		writeDesktopStartupLog(`[desktop-window] load-url ${devServerUrl}`)
		await window.loadURL(devServerUrl)
		return
	}

	if (!fs.existsSync(indexHtmlPath)) {
		writeDesktopStartupLog(`[desktop-window] ui-entry-missing ${indexHtmlPath}`)
		throw new Error(`Desktop UI entry was not found: ${indexHtmlPath}`)
	}
	writeDesktopStartupLog(`[desktop-window] load-file ${indexHtmlPath}`)
	await window.loadFile(indexHtmlPath)
}
