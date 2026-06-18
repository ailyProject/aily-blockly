import type { CategoryCount } from 'core/hardware'

/**
 * Blockly 编辑器页面展示状态
 */
export interface BlocklyEditorState {
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
}
