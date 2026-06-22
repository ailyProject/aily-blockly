import { launchDesktopApp } from './app'

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
 * 仅当当前包被 Electron 直接作为主进程入口执行时，自动启动应用。
 */
const shouldAutoLaunchDesktopApp = () =>
	typeof process !== 'undefined' &&
	Boolean(process.versions?.electron) &&
	typeof require !== 'undefined' &&
	typeof module !== 'undefined' &&
	require.main === module

if (shouldAutoLaunchDesktopApp()) {
	void launchDesktopApp().catch(error => {
		console.error(error)
		process.exitCode = 1
	})
}
