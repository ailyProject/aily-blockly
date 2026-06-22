import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { HardwareEsptoolPlatform } from '../types'

/**
 * 判断某个路径是否是目录。
 * @param path - 目标路径
 */
export const isEsptoolDirectory = (path: string) => {
	try {
		return statSync(path).isDirectory()
	} catch {
		return false
	}
}

/**
 * 解析 esptool 模型缓存目录。
 * @param appDataPath - 应用数据目录
 */
export const resolveHardwareEsptoolTempDir = (appDataPath: string) =>
	join(appDataPath.replace('aily-project', 'aily-builder'), 'model')

/**
 * 兼容旧导出名的 esptool 模型缓存目录解析。
 * @param appDataPath - 应用数据目录
 */
export const resolveEsptoolTempDir = resolveHardwareEsptoolTempDir

/**
 * 解析 esptool 可执行文件路径。
 * @param packagePath - 工具包路径
 * @param platform - 宿主平台
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
