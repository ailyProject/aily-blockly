import { generatePinSummaries } from './pinmap'

import type { ConnectionPinSummary, ConnectionPromptBundle } from './types'

const systemPrompt = `You are an embedded hardware wiring assistant. Analyze board and peripheral pin definitions, then produce safe wiring plans in structured JSON.`
const userPromptTemplate = `Board and peripheral pin summaries:\n{{PIN_SUMMARY_JSON}}\n{{EXTRA_REQUIREMENTS}}`

/**
 * 构建 user prompt。
 * @param pinSummaries - 引脚摘要
 * @param extraRequirements - 额外需求
 */
export const buildConnectionUserPrompt = (pinSummaries: Array<ConnectionPinSummary>, extraRequirements?: string) =>
	userPromptTemplate
		.replace('{{PIN_SUMMARY_JSON}}', JSON.stringify(pinSummaries, null, 2))
		.replace('{{EXTRA_REQUIREMENTS}}', extraRequirements ? `Extra requirements:\n- ${extraRequirements}` : '')

/**
 * 构建完整 prompt。
 * @param boardPackagePath - 开发板包路径
 * @param peripheralConfigPaths - 外设配置路径列表
 * @param extraRequirements - 额外需求
 */
export const buildConnectionPrompt = (
	boardPackagePath: string,
	peripheralConfigPaths?: Array<string>,
	extraRequirements?: string
): ConnectionPromptBundle => {
	const pinSummaries = generatePinSummaries(boardPackagePath, peripheralConfigPaths)

	return {
		systemPrompt,
		userPrompt: buildConnectionUserPrompt(pinSummaries, extraRequirements),
		pinSummaries
	}
}
