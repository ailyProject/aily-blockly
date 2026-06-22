import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { contextBridge } from 'electron'
import { exposeElectronTRPC } from 'erpc/main'

const preloadLogPath = path.join(os.tmpdir(), 'aily-blockly-desktop.log')

const writePreloadLog = (message: string) => {
	const line = `[${new Date().toISOString()}] [desktop-preload] ${message}\n`
	fs.appendFileSync(preloadLogPath, line)
}

let preloadBridgeExposed = false

const exposePreloadBridges = () => {
	if (preloadBridgeExposed) {
		writePreloadLog('expose-skipped-already-exposed')
		return
	}

	preloadBridgeExposed = true
	contextBridge.exposeInMainWorld('$desktopPreload', {
		ready: true
	})
	writePreloadLog('contextBridge-exposed-$desktopPreload')
	exposeElectronTRPC()
	writePreloadLog('exposeElectronTRPC')
}

/**
 * Electron preload 薄壳入口
 */
export const bootstrapDesktopPreload = (): void => {
	writePreloadLog('bootstrap-start')
	process.once('loaded', () => {
		try {
			writePreloadLog('process-loaded')
			exposePreloadBridges()
		} catch (error) {
			writePreloadLog(`process-loaded-error ${error instanceof Error ? error.stack || error.message : String(error)}`)
			throw error
		}
	})
}

bootstrapDesktopPreload()
