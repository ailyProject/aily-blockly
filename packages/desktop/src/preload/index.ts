import { exposeElectronTRPC } from 'erpc/main'

/**
 * Electron preload 薄壳入口
 */
export const bootstrapDesktopPreload = (): void => {
	process.once('loaded', () => {
		exposeElectronTRPC()
	})
}
