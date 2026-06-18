/**
 * 工作区嵌入目标元数据
 */
export interface WorkspaceEmbedTarget {
	/** 嵌入目标唯一标识 */
	id: string
	/** 嵌入目标显示标题 */
	title: string
	/** 嵌入目标摘要说明 */
	summary: string
	/** 可直接加载的目标 URL */
	url: string
}
