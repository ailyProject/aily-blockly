import { launchDesktopApp } from './app'
import { installDesktopProcessErrorLogging, writeDesktopStartupLog } from './app/log'

export * from './app'
export * from './bootstrap'
export * from './core-service'
export * from './rpc'
export * from './ble'
export * from './project-open'
export * from './terminal'
export * from './types'
export type { Router } from './rpc/types'

/**
 * 当当前 bundle 运行在 Electron 主进程里时，自动启动桌面应用。
 */
const shouldAutoLaunchDesktopApp = () =>
	typeof process !== 'undefined' && Boolean(process.versions?.electron) && process.type !== 'renderer'

if (shouldAutoLaunchDesktopApp()) {
	installDesktopProcessErrorLogging()
	void launchDesktopApp().catch(error => {
		writeDesktopStartupLog(
			`[desktop-process] launchDesktopApp-catch ${error instanceof Error ? error.stack || error.message : String(error)}`
		)
		console.error(error)
		process.exitCode = 1
	})
}
