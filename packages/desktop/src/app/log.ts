import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const desktopStartupLogPath = path.join(os.tmpdir(), 'aily-blockly-desktop.log')

/**
 * 读取 desktop 主进程启动日志文件路径。
 */
export const getDesktopStartupLogPath = () => desktopStartupLogPath

/**
 * 清空 desktop 主进程启动日志。
 */
export const resetDesktopStartupLog = () => {
	fs.writeFileSync(desktopStartupLogPath, '')
}

/**
 * 向系统临时目录中的 desktop 启动日志追加一行。
 * @param message - 日志内容
 */
export const writeDesktopStartupLog = (message: string) => {
	const line = `[${new Date().toISOString()}] ${message}\n`
	fs.appendFileSync(desktopStartupLogPath, line)
}
