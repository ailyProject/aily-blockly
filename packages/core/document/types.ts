import type { BlocklyWorkspaceBlockNode, BlocklyWorkspaceContent } from '../metadata'

/**
 * Blockly 视图状态
 */
export interface BlocklyWorkspaceViewState {
	/** 当前缩放比例 */
	scale: number
	/** 当前横向滚动偏移 */
	scrollX: number
	/** 当前纵向滚动偏移 */
	scrollY: number
}

/**
 * Blockly 页面快照
 */
export interface BlocklyPageSnapshot {
	/** 页面 ID */
	id: string
	/** 页面标题 */
	title: string
	/** 页面工作区内容 */
	content: BlocklyWorkspaceContent
	/** 页面视图状态 */
	viewState: BlocklyWorkspaceViewState
}

/**
 * Blockly 共享模型
 */
export interface BlocklySharedModel {
	/** 共享变量定义 */
	variables?: unknown
	/** 跨页面共享的过程块 */
	procedureBlocks: Array<BlocklyWorkspaceBlockNode>
}

/**
 * Blockly 项目文档
 */
export interface BlocklyProjectDocument {
	/** 文档 schema 版本 */
	schemaVersion: number
	/** 当前激活页面 ID */
	activePageId: string
	/** 当前打开页面 ID 列表 */
	openedPageIds: Array<string>
	/** 页面快照列表 */
	pages: Array<BlocklyPageSnapshot>
	/** 共享模型 */
	sharedModel: BlocklySharedModel
}
