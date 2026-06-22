import type { WritableSignal } from '@angular/core'
import type { CategoryCount } from '@core'
import type { MissingBlocklyLibraryInfo } from 'shared'

/**
 * Blockly 页面摘要。
 */
export interface BlocklyEditorPageSummary {
	/** 页面唯一标识。 */
	id: string
	/** 页面标题。 */
	title: string
	/** 当前页面块数量。 */
	blockCount: number
	/** 当前页面是否处于打开状态。 */
	opened: boolean
	/** 当前页面是否为激活页面。 */
	active: boolean
}

/**
 * Blockly 激活页面视图状态。
 */
export interface BlocklyEditorActiveViewState {
	/** 当前缩放比例。 */
	scale: number
	/** 当前横向滚动偏移。 */
	scrollX: number
	/** 当前纵向滚动偏移。 */
	scrollY: number
}

/**
 * Blockly 当前激活工作区预览。
 */
export interface BlocklyEditorActiveWorkspacePreview {
	/** 当前顶层块数量。 */
	topLevelBlockCount: number
	/** 当前顶层块类型。 */
	topLevelBlockTypes: Array<string>
	/** 当前工作区 JSON 预览。 */
	workspaceJson: string
}

/**
 * Blockly 编辑器页面展示状态
 */
export interface BlocklyEditorState {
	/** 当前项目路径。 */
	projectPath: string
	/** 分类后的板卡统计 */
	categories: Array<CategoryCount>
	/** 开发板 legacy 校验结果 */
	boardValidation: string
	/** 库 legacy 校验结果 */
	libraryValidation: string
	/** 当前工具栏应用数量 */
	toolbarCount: number
	/** 当前可见工具栏应用数量 */
	visibleToolbarCount: number
	/** 当前解析出的语言 */
	language: string
	/** 搜索命中的条目名称列表 */
	searchResultNames: Array<string>
	/** 当前项目是否存在 ABI 文件。 */
	abiExists: boolean
	/** ABI 文件路径。 */
	abiFilePath: string
	/** 解析 `project.abi` 时的错误。 */
	abiParseError?: string
	/** ABI schema 版本。 */
	abiSchemaVersion?: number
	/** 当前激活页面 ID。 */
	activePageId?: string
	/** 当前打开页面数量。 */
	openedPageCount: number
	/** 当前页面总数。 */
	pageCount: number
	/** 当前文档总块数。 */
	totalBlockCount: number
	/** 当前激活页面标题。 */
	activePageTitle?: string
	/** 当前激活页面视图状态。 */
	activeViewState?: BlocklyEditorActiveViewState
	/** 当前激活工作区预览。 */
	activeWorkspace: BlocklyEditorActiveWorkspacePreview
	/** 共享变量数量。 */
	sharedVariableCount: number
	/** 共享过程块数量。 */
	sharedProcedureCount: number
	/** 页面摘要列表。 */
	pages: Array<BlocklyEditorPageSummary>
	/** 当前仍缺失的 Blockly 库。 */
	missingLibraries: Array<MissingBlocklyLibraryInfo>
}

/**
 * Blockly editor 页面集中管理的 signal 集合。
 */
export interface BlocklyEditorSignals {
	projectPath: WritableSignal<string>
	categories: WritableSignal<Array<{ name: string; count: number }>>
	boardValidation: WritableSignal<string>
	libraryValidation: WritableSignal<string>
	toolbarCount: WritableSignal<number>
	visibleToolbarCount: WritableSignal<number>
	language: WritableSignal<string>
	abiExists: WritableSignal<boolean>
	abiFilePath: WritableSignal<string>
	abiParseError: WritableSignal<string | undefined>
	abiSchemaVersion: WritableSignal<number | undefined>
	activePageId: WritableSignal<string>
	activePageTitle: WritableSignal<string>
	activeViewState: WritableSignal<BlocklyEditorActiveViewState | null>
	activeViewScaleDraft: WritableSignal<string>
	activeViewScrollXDraft: WritableSignal<string>
	activeViewScrollYDraft: WritableSignal<string>
	activeTopLevelBlockCount: WritableSignal<number>
	activeTopLevelBlockTypes: WritableSignal<Array<string>>
	activeWorkspaceJson: WritableSignal<string>
	activeWorkspaceDirty: WritableSignal<boolean>
	activeWorkspaceParseError: WritableSignal<string | null>
	activeWorkspaceSaveBusy: WritableSignal<boolean>
	activeWorkspaceSaveMessage: WritableSignal<string | null>
	projectReloadBusy: WritableSignal<boolean>
	projectReloadMessage: WritableSignal<string | null>
	missingLibraries: WritableSignal<Array<MissingBlocklyLibraryInfo>>
	missingLibraryActionBusyKey: WritableSignal<string | null>
	missingLibraryActionMessage: WritableSignal<string | null>
	renamingPageId: WritableSignal<string>
	renamingPageTitle: WritableSignal<string>
	openedPageCount: WritableSignal<number>
	pageCount: WritableSignal<number>
	totalBlockCount: WritableSignal<number>
	sharedVariableCount: WritableSignal<number>
	sharedProcedureCount: WritableSignal<number>
	pages: WritableSignal<Array<BlocklyEditorPageSummary>>
	searchQuery: WritableSignal<string>
	searchResultNames: WritableSignal<Array<string>>
}
