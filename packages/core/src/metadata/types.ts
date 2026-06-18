/**
 * Blockly 块节点
 */
export interface BlocklyWorkspaceBlockNode {
	/** 块类型 */
	type?: string
	/** 输入槽位映射 */
	inputs?: Record<string, { block?: BlocklyWorkspaceBlockNode; shadow?: BlocklyWorkspaceBlockNode }>
	/** 下一个语句块 */
	next?: { block?: BlocklyWorkspaceBlockNode }
}

/**
 * Blockly 工作区内容
 */
export interface BlocklyWorkspaceContent {
	/** 工作区块集合 */
	blocks?: {
		/** Blockly 序列化 languageVersion */
		languageVersion?: number
		/** 顶层块数组 */
		blocks?: Array<BlocklyWorkspaceBlockNode>
	}
}

/**
 * Blockly 项目页面
 */
export interface BlocklyProjectDocumentPage {
	/** 页面工作区内容 */
	content?: BlocklyWorkspaceContent | null
}

/**
 * Blockly 项目文档
 */
export interface BlocklyProjectDocument {
	/** 页面列表 */
	pages: Array<BlocklyProjectDocumentPage>
	/** 跨页面共享模型 */
	sharedModel?: {
		/** 共享的过程块 */
		procedureBlocks?: Array<BlocklyWorkspaceBlockNode>
	}
}

/**
 * 已使用库 manifest 条目
 */
export interface BlocklyUsedLibraryManifestEntry {
	/** 依赖版本或文件引用 */
	version: string
	/** 本地路径 */
	localPath?: string
	/** 命中的 block type 列表 */
	blockTypes: Array<string>
	/** 更新时间戳 */
	updatedAt: number
}

/**
 * 已使用库 manifest
 */
export type BlocklyUsedLibraryManifest = Record<string, BlocklyUsedLibraryManifestEntry>

/**
 * block type 到库的绑定信息
 */
export interface BlockLibraryBinding {
	/** 库名 */
	name: string
	/** 库版本 */
	version: string
	/** 本地路径 */
	localPath?: string
}

/**
 * 缺失的 Blockly 库信息
 */
export interface MissingBlocklyLibraryInfo {
	/** 触发该缺失判定的 block type */
	blockType: string
	/** 缺失的库包名 */
	name: string
	/** 希望安装或恢复的版本 */
	version: string
	/** 本地库路径，若为 file: 依赖则会解析到具体路径 */
	localPath: string
}
