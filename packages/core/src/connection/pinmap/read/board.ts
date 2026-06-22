import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { extractConnectionPinSummary } from '../extract'
import { readConnectionComponentConfig, readConnectionPinmapCatalog } from './catalog'

import type { ConnectionPinSummary } from '../../types'

/**
 * 解析开发板 pinmap 文件路径。
 * @param boardPackagePath - 开发板包路径
 */
export const resolveBoardPinmapPath = (boardPackagePath: string) => {
	const legacyPath = join(boardPackagePath, 'pinmap.json')
	if (existsSync(legacyPath)) return legacyPath

	const catalog = readConnectionPinmapCatalog(boardPackagePath)
	const model = catalog?.models?.[0]
	const variant =
		model?.variants.find(item => item.isDefault) ||
		model?.variants.find(item => item.status === 'available') ||
		model?.variants[0]
	if (!variant?.pinmapFile) return null

	const resolvedPath = join(boardPackagePath, variant.pinmapFile)
	return existsSync(resolvedPath) ? resolvedPath : null
}

/**
 * 读取开发板配置。
 * @param boardPackagePath - 开发板包路径
 */
export const readBoardPinmapConfig = (boardPackagePath: string) => {
	const pinmapPath = resolveBoardPinmapPath(boardPackagePath)
	return pinmapPath ? readConnectionComponentConfig(pinmapPath) : null
}

/**
 * 读取开发板引脚摘要。
 * @param boardPackagePath - 开发板包路径
 */
export const readBoardPinSummary = (boardPackagePath: string): ConnectionPinSummary | null => {
	const config = readBoardPinmapConfig(boardPackagePath)
	return config ? extractConnectionPinSummary(config) : null
}

/**
 * 扫描开发板目录下的外设配置文件。
 * @param boardPackagePath - 开发板包路径
 */
export const findPeripheralConfigPaths = (boardPackagePath: string) =>
	readdirSync(boardPackagePath)
		.filter(name => name.endsWith('_config.json') && name !== 'pinmap.json')
		.map(name => join(boardPackagePath, name))
