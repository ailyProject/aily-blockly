import { spawn } from 'node:child_process'
import { path7za } from '7zip-bin'

const PROJECT_ARCHIVE_EXCLUDES = [
	'node_modules',
	'.chat',
	'.history',
	'.temp',
	'.aily',
	'.aily_checkpoints',
	'.chat_history',
	'package-lock.json',
	'project.7z',
	'project.abi.backup',
	'project.abs'
]

/**
 * 构建项目归档命令参数。
 * @param archivePath - 目标 7z 路径
 */
export const createProjectArchiveCommandArgs = (archivePath: string) => [
	'a',
	'-t7z',
	'-mx=9',
	archivePath,
	'.',
	...PROJECT_ARCHIVE_EXCLUDES.map(pattern => `-x!${pattern}`)
]

/**
 * 执行项目归档命令。
 * @param projectPath - 当前项目目录
 * @param archivePath - 目标归档路径
 */
export const runProjectArchiveCommand = (projectPath: string, archivePath: string) =>
	new Promise<void>((resolve, reject) => {
		const child = spawn(path7za, createProjectArchiveCommandArgs(archivePath), {
			cwd: projectPath,
			stdio: ['ignore', 'pipe', 'pipe']
		})

		let stderr = ''
		child.stderr?.on('data', chunk => {
			stderr += chunk.toString()
		})
		child.on('error', reject)
		child.on('close', exitCode => {
			if (exitCode === 0) {
				resolve()
				return
			}

			reject(new Error(stderr.trim() || `项目打包失败，退出码: ${exitCode ?? 1}`))
		})
	})
