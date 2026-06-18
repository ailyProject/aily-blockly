import type { BlocklyProjectDocument } from '../document'
import type { BlocklyWorkspaceContent } from '../metadata'

/**
 * ABI 归一化后的载荷
 */
export type ProjectAbiPayload = BlocklyProjectDocument | BlocklyWorkspaceContent

/**
 * ABI 文本解析结果
 */
export interface ParsedProjectAbi {
	/** 原始 JSON 文本 */
	raw: string
	/** 归一化后的 ABI 载荷 */
	payload: ProjectAbiPayload
}
