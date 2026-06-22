import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const desktopStartupLogPath = path.join(os.tmpdir(), 'aily-blockly-desktop.log')

/**
 * 读取系统临时目录中的 desktop 启动日志路径。
 */
export const getDesktopStartupLogPath = () => desktopStartupLogPath

/**
 * 重置 desktop 启动日志。
 */
export const resetDesktopStartupLog = () => {
	fs.writeFileSync(desktopStartupLogPath, '')
}

/**
 * 追加 desktop 启动日志。
 * @param {string} message
 */
export const writeDesktopStartupLog = message => {
	fs.appendFileSync(desktopStartupLogPath, `[${new Date().toISOString()}] ${message}\n`)
}
