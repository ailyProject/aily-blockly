const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const logPath = path.join(os.tmpdir(), 'aily-blockly-desktop.log')
const log = message => {
	fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`)
}

log('[electron-entry] require-start')

const { launchDesktopApp } = require('../dist/main/index.cjs')

log('[electron-entry] require-finish')

void launchDesktopApp().catch(error => {
	log(`[electron-entry] launch-error ${error instanceof Error ? error.stack || error.message : String(error)}`)
	console.error(error)
	process.exitCode = 1
})
