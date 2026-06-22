import type { CloudProjectSummary } from 'shared'

/**
 * 新建项目页最近项目条目
 */
export interface ProjectNewRecentItem {
	/** 最近项目名称 */
	name: string
	/** 最近项目路径 */
	path: string
	/** 回填到输入框的昵称 */
	nickname?: string
}

/**
 * 新建项目页的当前板卡云端状态。
 */
export interface ProjectNewBoardCloudState {
	/** 当前板卡可导入的模板列表。 */
	templates: Array<ProjectNewCloudTemplate>
	/** 当前板卡是否存在公开示例项目。 */
	hasExamples: boolean
}

/**
 * 项目模板来源模式。
 */
export type ProjectNewTemplateSourceMode =
	/** 优先读取当前用户可见的模板列表。 */
	| 'mine'
	/** 使用匿名可见模板列表。 */
	| 'public'

export type ProjectNewCloudTemplate = CloudProjectSummary
