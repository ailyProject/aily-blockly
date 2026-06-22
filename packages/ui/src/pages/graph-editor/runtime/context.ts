import type { Core } from '@/utils/core'

/**
 * 读取当前 graph 的组件配置映射。
 * @param core - Core tRPC 句柄
 * @param input - 板卡包路径、依赖路径与 graph 数据
 */
export const loadGraphEditorComponentConfigs = async (input: {
	core: Core
	boardPackagePath: string
	packagesBasePath: string
	connectionData: unknown
}) => {
	if (!input.boardPackagePath || !input.packagesBasePath) return ''

	const configs = await input.core.connection.collectConfigs.query({
		boardPackagePath: input.boardPackagePath,
		packagesBasePath: input.packagesBasePath,
		connectionData: input.connectionData as never
	})
	return JSON.stringify(configs, null, 2)
}

/**
 * 读取当前 graph 对应的连线 prompt。
 * @param core - Core tRPC 句柄
 * @param input - 板卡包路径与额外的外设配置路径
 */
export const loadGraphEditorPromptInfo = async (input: {
	core: Core
	boardPackagePath: string
	extraRequirements?: string
}) => {
	if (!input.boardPackagePath) {
		return {
			systemPrompt: '',
			userPrompt: '',
			pinSummaryCount: 0
		}
	}

	const prompt = await input.core.connection.buildPrompt.query({
		boardPackagePath: input.boardPackagePath,
		extraRequirements: input.extraRequirements
	})

	return {
		systemPrompt: prompt.systemPrompt,
		userPrompt: prompt.userPrompt,
		pinSummaryCount: prompt.pinSummaries.length
	}
}
