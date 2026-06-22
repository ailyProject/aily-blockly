import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const desktopStartupLogPath = path.join(os.tmpdir(), 'aily-blockly-desktop.log')
const desktopPidFilePath = path.join(os.tmpdir(), 'aily-blockly-desktop.pid')

/**
 * 读取系统临时目录中的 desktop 启动日志路径。
 */
export const getDesktopStartupLogPath = () => desktopStartupLogPath

/**
 * 读取 desktop 进程 pid 文件路径。
 */
export const getDesktopPidFilePath = () => desktopPidFilePath

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

/**
 * 写入当前 desktop Electron 进程 pid。
 * @param {number} pid
 */
export const writeDesktopPid = pid => {
	fs.writeFileSync(desktopPidFilePath, String(pid))
}

/**
 * 读取上次记录的 desktop Electron 进程 pid。
 * @returns {number | null}
 */
export const readDesktopPid = () => {
	if (!fs.existsSync(desktopPidFilePath)) return null

	const raw = fs.readFileSync(desktopPidFilePath, 'utf8').trim()
	const pid = Number.parseInt(raw, 10)
	return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * 清空 desktop Electron 进程 pid 文件。
 */
export const clearDesktopPid = () => {
	if (fs.existsSync(desktopPidFilePath)) {
		fs.rmSync(desktopPidFilePath, { force: true })
	}
}
