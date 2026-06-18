/**
 * 模型目录来源
 */
export type ModelCatalogSource =
	/** 来自远端模型服务 */
	| 'remote'
	/** 来自本地 fallback 数据 */
	| 'fallback'

/**
 * 模型任务类型
 */
export type ModelCatalogTask =
	/** 图像分类 */
	| 'classification'
	/** 目标检测 */
	| 'detection'
	/** 图像分割 */
	| 'segmentation'
	/** 姿态估计 */
	| 'pose'
	/** 生成式模型 */
	| 'generative'
	/** 音频识别 */
	| 'audio'
	/** 未知或未映射任务 */
	| 'unknown'

/**
 * 模型标签
 */
export interface ModelCatalogLabel {
	/** 标签对象标识 */
	id: string
	/** 标签对象名称 */
	name: string
}

/**
 * 模型目录列表项
 */
export interface ModelCatalogItem {
	/** 模型唯一标识 */
	id: string
	/** 模型显示名称 */
	name: string
	/** 模型摘要 */
	description: string
	/** 模型作者标识 */
	authorId: string
	/** 模型作者显示名称 */
	authorName: string
	/** 模型封面地址 */
	coverUrl: string
	/** 模型体积描述 */
	modelSize: string
	/** 模型任务类型 */
	task: ModelCatalogTask
	/** 模型场景描述 */
	scenario: string
	/** 模型格式 */
	modelFormat: string
	/** 模型框架 */
	aiFramework: string
	/** 模型精度 */
	precision: string
	/** 模型创建时间 */
	createdAt: string
	/** 点赞数量 */
	likeCount: number
	/** 收藏数量 */
	followCount: number
	/** 部署次数 */
	deployCount: number
	/** 模型优先级 */
	priority: number
	/** 适配目标类型列表 */
	adaptedTypes: Array<string>
	/** 统一开发板类型列表 */
	uniformTypes: Array<string>
	/** 支持的开发板显示名称列表 */
	supportedBoards: Array<string>
	/** 推荐部署目标 */
	deployTarget: string
}

/**
 * 模型目录详情
 */
export interface ModelCatalogDetail extends ModelCatalogItem {
	/** 模型详细内容 */
	content: string
	/** 模型文件下载地址 */
	fileUrl: string
	/** 模型准备步骤 */
	preparation: Array<string>
	/** 模型校验和 */
	checksum: string
	/** 推荐 IOU 阈值 */
	iou: string
	/** 推荐置信度阈值 */
	confidence: string
	/** 当前是否启用 */
	enabled: boolean
	/** 当前版本号 */
	version: string
	/** 标签列表 */
	labels: Array<ModelCatalogLabel>
}

/**
 * 模型目录列表结果
 */
export interface ModelCatalogListResult {
	/** 当前返回的模型条目列表 */
	items: Array<ModelCatalogItem>
	/** 当前查询总数 */
	total: number
	/** 当前总页数 */
	totalPages: number
	/** 当前页码 */
	page: number
	/** 当前每页条数 */
	pageSize: number
	/** 当前结果来源 */
	source: ModelCatalogSource
}
