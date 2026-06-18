import type { RecentModelProject } from 'shared'

/**
 * 模型训练页展示状态
 */
export interface ModelTrainState {
	/** 最近模型项目列表 */
	recentModels: Array<RecentModelProject>
	/** 分类模型项目数量 */
	classificationCount: number
	/** 检测模型项目数量 */
	detectionCount: number
}
