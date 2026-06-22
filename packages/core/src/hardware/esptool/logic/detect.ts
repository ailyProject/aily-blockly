import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isEsptoolDirectory, resolveHardwareEsptoolExecutable } from './shared'

import type { HardwareEsptoolPackageInfo, HardwareEsptoolPlatform } from '../types'

/**
 * 检测已安装的 esptool 包。
 * @param input - 检测输入
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
		if (!isEsptoolDirectory(packagePath)) continue

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
