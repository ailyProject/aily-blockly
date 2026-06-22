import type {
	AilyAppConfig,
	ModelCatalogDetail,
	ModelCatalogItem,
	ModelCatalogListResult,
	ModelCatalogTask
} from 'shared'

/**
 * 模型目录 fallback 数据
 */
export interface ModelCatalogFallback {
	/** fallback 列表 */
	items: Array<ModelCatalogItem>
	/** fallback 详情映射 */
	details: Record<string, ModelCatalogDetail>
}

/**
 * 远端模型列表条目
 */
export interface RemoteModelListItem {
	/** 模型唯一标识 */
	id: string
	/** 模型显示名称 */
	name: string
	/** 模型摘要 */
	description: string
	/** 作者标识 */
	author: string
	/** 作者显示名称 */
	author_name: string
	/** 模型封面地址 */
	pic_url: string
	/** 模型体积 */
	model_size: string
	/** 任务类型编号 */
	task: string
	/** 模型场景 */
	scenario: string
	/** 模型格式 */
	model_format: string
	/** 模型框架 */
	ai_framework: string
	/** 模型精度 */
	precision: string
	/** 创建时间 */
	created: string
	/** 点赞数 */
	like_num: string
	/** 收藏数 */
	follow_num: string
	/** 部署次数 */
	deploy_num: string
	/** 优先级 */
	priority: string
	/** 适配列表 */
	adapteds: Array<string>
	/** 统一目标类型 */
	uniform_types: Array<string>
}

/**
 * 远端模型列表响应
 */
export interface RemoteModelListResponse {
	/** 业务状态码 */
	code?: string
	/** 数据主体 */
	data?: {
		/** 总数 */
		total?: string
		/** 列表数据 */
		list?: Array<RemoteModelListItem>
	}
}

/**
 * 远端模型标签
 */
export interface RemoteModelLabel {
	/** 标签对象标识 */
	object_id: string
	/** 标签对象名称 */
	object_name: string
}

/**
 * 远端模型详情
 */
export interface RemoteModelDetail extends RemoteModelListItem {
	/** 模型详细内容 */
	content: string
	/** 文件下载地址 */
	file_url: string
	/** 准备步骤 */
	preparation: Array<string>
	/** 校验和 */
	checksum: string
	/** 推理参数 */
	attr: { iou: string; conf: string }
	/** 当前是否启用 */
	is_enabled: boolean
	/** 当前版本 */
	version: string
	/** 标签列表 */
	labels: Array<RemoteModelLabel>
}

/**
 * 远端模型详情响应
 */
export interface RemoteModelDetailResponse {
	/** HTTP 语义状态 */
	status?: number
	/** 业务状态码 */
	code?: string
	/** 详情数据 */
	data?: RemoteModelDetail
}

/**
 * 模型目录查询参数
 */
export interface ModelCatalogQuery {
	/** 页码，从 1 开始 */
	page: number
	/** 每页条数 */
	pageSize: number
	/** 搜索关键词 */
	search?: string
	/** 统一开发板类型 */
	uniformType?: string
	/** 指定语言 */
	language?: string
}

/**
 * 模型目录远端访问参数
 */
export interface ModelCatalogRequest {
	/** 应用配置 */
	config?: AilyAppConfig
	/** 查询参数 */
	query?: Partial<ModelCatalogQuery>
}

/**
 * 模型目录详情访问参数
 */
export interface ModelCatalogDetailRequest {
	/** 应用配置 */
	config?: AilyAppConfig
	/** 模型标识 */
	modelId: string
	/** 指定语言 */
	language?: string
}

/**
 * 模型任务映射表
 */
export type ModelTaskMap = Record<string, ModelCatalogTask>

/**
 * 模型目录列表加载结果
 */
export interface LoadModelCatalogResult extends ModelCatalogListResult {}

export type { ModelCatalogDetail, ModelCatalogItem }
