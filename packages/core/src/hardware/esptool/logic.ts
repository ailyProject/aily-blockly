import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type {
	HardwareEsptoolFlashFileItem,
	HardwareEsptoolFlashOptions,
	HardwareEsptoolInstallResult,
	HardwareEsptoolPackageInfo,
	HardwareEsptoolPlatform
} from './types'

const isDirectory = (path: string) => {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

/**
 * 解析 esptool 模型缓存目录。
 * @param {string} appDataPath - 应用数据目录
 * @returns {string}
 */
export const resolveHardwareEsptoolTempDir = (appDataPath: string) =>
	join(appDataPath.replace('aily-project', 'aily-builder'), 'model')

/**
 * 解析 esptool 可执行文件路径。
 * @param {string} packagePath - 工具包路径
 * @param {HardwareEsptoolPlatform} platform - 宿主平台
 * @returns {string | null}
 */
export const resolveHardwareEsptoolExecutable = (packagePath: string, platform: HardwareEsptoolPlatform) => {
	const candidates =
		platform === 'windows'
			? [join(packagePath, 'esptool.exe'), join(packagePath, 'bin', 'esptool.exe')]
			: [join(packagePath, 'esptool'), join(packagePath, 'bin', 'esptool')]

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate
	}

	return null
}

/**
 * 检测已安装的 esptool 包。
 * @param {{appDataPath: string, platform: HardwareEsptoolPlatform}} input - 检测输入
 * @returns {HardwareEsptoolPackageInfo | null}
 */
export const detectHardwareEsptool = (input: {
	appDataPath: string
	platform: HardwareEsptoolPlatform
}): HardwareEsptoolPackageInfo | null => {
	const nodeModulesPath = join(input.appDataPath, 'node_modules')
	const toolsPath = join(input.appDataPath, 'tools')
	const scopePath = join(nodeModulesPath, '@aily-project')

	if (!existsSync(nodeModulesPath) || !existsSync(scopePath)) return null

	for (const entry of readdirSync(scopePath)) {
		if (entry !== 'tool-esptool_py') continue

		const packagePath = join(scopePath, entry)
		if (!isDirectory(packagePath)) continue

		const packageJsonPath = join(packagePath, 'package.json')
		if (!existsSync(packageJsonPath)) continue

		const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
			name?: string
			version?: string
		}
		if (!packageJson.name || !packageJson.version) continue

		const toolDir = join(toolsPath, `esptool_py@${packageJson.version}`)
		if (!existsSync(toolDir)) continue

		const executable = resolveHardwareEsptoolExecutable(toolDir, input.platform)
		if (!executable) continue

		return {
			name: packageJson.name,
			version: packageJson.version,
			installed: true,
			esptoolPath: executable
		}
	}

	return null
}

/**
 * 安装 esptool 包。
 * @param {{appDataPath: string, platform: HardwareEsptoolPlatform, packageSpec?: string}} input - 安装输入
 * @returns {Promise<HardwareEsptoolInstallResult>}
 */
export const installHardwareEsptool = async (input: {
	appDataPath: string
	platform: HardwareEsptoolPlatform
	packageSpec?: string
}): Promise<HardwareEsptoolInstallResult> => {
	try {
		if (!existsSync(input.appDataPath)) {
			mkdirSync(input.appDataPath, { recursive: true })
		}

		const packageSpec = input.packageSpec || '@aily-project/tool-esptool_py@latest'
		const command = process.platform === 'win32' ? 'npm.cmd' : 'npm'

		const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
			const child = spawn(command, ['install', packageSpec], {
				cwd: input.appDataPath,
				stdio: ['ignore', 'pipe', 'pipe']
			})

			let stderr = ''
			child.stderr.on('data', chunk => {
				stderr += chunk.toString()
			})
			child.on('error', reject)
			child.on('close', code => resolve({ code, stderr }))
		})

		if (result.code !== 0) {
			return {
				success: false,
				error: result.stderr.trim() || `npm install exited with code ${result.code}`
			}
		}

		const packageInfo = detectHardwareEsptool({
			appDataPath: input.appDataPath,
			platform: input.platform
		})

		return {
			success: packageInfo !== null,
			packageInfo,
			message: packageInfo ? 'esptool installed successfully' : 'esptool installed but executable was not detected',
			...(packageInfo ? {} : { error: 'esptool executable was not detected after install' })
		}
	} catch (error) {
		return {
			success: false,
			error: (error as Error).message
		}
	}
}

/**
 * 构建单文件烧录命令。
 * @param {{esptoolPath: string, file: HardwareEsptoolFlashFileItem, options: Omit<HardwareEsptoolFlashOptions, 'flashFiles'>}} input - 命令输入
 * @returns {string}
 */
export const buildHardwareEsptoolFlashCommand = (input: {
	esptoolPath: string
	file: HardwareEsptoolFlashFileItem
	options: Omit<HardwareEsptoolFlashOptions, 'flashFiles'>
	tempFilePath: string
}) => {
	const chip = input.options.chip || 'esp32s3'
	const baudRate = input.options.baudRate || 460800
	const beforeFlash = input.options.beforeFlash || 'default_reset'
	const afterFlash = input.options.afterFlash || 'hard_reset'
	const address = `0x${input.file.address.toString(16)}`

	return `& "${input.esptoolPath}" --chip ${chip} --port ${input.options.port} --baud ${baudRate} --before ${beforeFlash} --after ${afterFlash} write_flash -z --flash_mode dio --flash_freq 80m --flash_size detect ${address} "${input.tempFilePath}"`
}
