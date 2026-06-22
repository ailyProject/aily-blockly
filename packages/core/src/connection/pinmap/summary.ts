import { extractConnectionPinSummary } from './extract'
import { findPeripheralConfigPaths, readBoardPinSummary, readConnectionComponentConfig } from './read'

import type { ConnectionPinSummary } from '../types'

/**
 * 生成完整引脚摘要。
 * @param boardPackagePath - 开发板包路径
 * @param peripheralConfigPaths - 外设配置路径列表
 */
export const generatePinSummaries = (boardPackagePath: string, peripheralConfigPaths?: Array<string>) => {
	const summaries: Array<ConnectionPinSummary> = []
	const boardSummary = readBoardPinSummary(boardPackagePath)
	if (boardSummary) summaries.push(boardSummary)

	for (const configPath of peripheralConfigPaths || findPeripheralConfigPaths(boardPackagePath)) {
		const config = readConnectionComponentConfig(configPath)
		if (config) summaries.push(extractConnectionPinSummary(config))
	}

	return summaries
}
