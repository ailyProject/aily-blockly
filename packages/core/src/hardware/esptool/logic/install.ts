import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'

import { detectHardwareEsptool } from './detect'

import type { HardwareEsptoolInstallResult, HardwareEsptoolPlatform } from '../types'

/**
 * 安装 esptool 包。
 * @param input - 安装输入
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
