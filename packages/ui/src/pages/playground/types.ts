/**
 * Playground 示例条目
 */
export interface PlaygroundExampleItem {
	/** 示例唯一标识 */
	id: string
	/** 示例显示名称 */
	title: string
	/** 面向用户的简要说明 */
	summary: string
	/** 关联开发板名称 */
	board: string
}

/**
 * Playground 专题条目
 */
export interface PlaygroundSubjectItem {
	/** 专题唯一标识，同时用于路由参数 */
	id: string
	/** 专题显示名称 */
	title: string
	/** 专题摘要 */
	summary: string
	/** 专题标签 */
	tag: string
	/** 该专题下的示例列表 */
	examples: Array<PlaygroundExampleItem>
}
