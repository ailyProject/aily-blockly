/**
 * 模型项目类型
 */
export type ModelType =
	/** 图像分类 */
	| 'classification'
	/** 目标检测 */
	| 'detection'
	/** 图像分割 */
	| 'segmentation'
	/** 姿态识别 */
	| 'pose'
/**
 * 最近打开的模型项目
 */
export interface RecentModelProject {
	/** 项目名称 */
	name: string
	/** 项目昵称 */
	nickname?: string
	/** 项目路径 */
	path: string
	/** 模型类型 */
	modelType: ModelType
	/** 最近更新时间 */
	updatedAt?: string
}
