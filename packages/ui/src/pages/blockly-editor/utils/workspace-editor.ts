/**
 * Blockly active workspace 草稿解析结果。
 */
export interface BlocklyWorkspaceDraftState {
	/** 当前草稿是否可被 JSON.parse 成功解析。 */
	valid: boolean
	/** 解析后的 payload；仅在 valid=true 时存在。 */
	payload?: unknown
	/** 顶层块数量预览。 */
	topLevelBlockCount: number
	/** 顶层块类型预览。 */
	topLevelBlockTypes: Array<string>
	/** 当前解析失败原因。 */
	error?: string
}

const resolveTopLevelBlocks = (payload: unknown) => {
	if (!payload || typeof payload !== 'object') return []

	const blocksContainer = (payload as { blocks?: { blocks?: unknown[] } }).blocks
	return Array.isArray(blocksContainer?.blocks) ? blocksContainer.blocks : []
}

/**
 * 解析当前 Blockly workspace JSON 草稿，并提取最小预览信息。
 * @param raw - 当前文本框中的 workspace JSON
 */
export const parseBlocklyWorkspaceDraft = (raw: string): BlocklyWorkspaceDraftState => {
	try {
		const payload = JSON.parse(raw)
		const topLevelBlocks = resolveTopLevelBlocks(payload)

		return {
			valid: true,
			payload,
			topLevelBlockCount: topLevelBlocks.length,
			topLevelBlockTypes: topLevelBlocks
				.map(block => (block && typeof block === 'object' ? (block as { type?: unknown }).type : undefined))
				.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
		}
	} catch (error) {
		return {
			valid: false,
			topLevelBlockCount: 0,
			topLevelBlockTypes: [],
			error: error instanceof Error ? error.message : String(error)
		}
	}
}
