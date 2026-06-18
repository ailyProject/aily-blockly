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
