import type { AilyAppConfig } from 'shared'

/**
 * 固件类型
 */
export type HardwareFirmwareType =
	/** Vision 固件 */
	| 'sscma_xiao_ai_s3'
	/** Audio 固件 */
	| 'xiao_audio'
	/** Vibration 固件 */
	| 'xiao_vibrate'

/**
 * XIAO 设备类型
 */
export type HardwareXiaoType =
	/** Vision 设备 */
	| 0
	/** Vibration 设备 */
	| 1
	/** Audio 设备 */
	| 2

/**
 * 固件信息
 */
export interface HardwareFirmwareInfo {
	/** 固件版本 */
	fwv: string
	/** 文件名称 */
	filename: string
	/** 文件下载地址 */
	file_url: string
	/** 资源配置地址 */
	resource_url: string
	/** 直接下载地址 */
	url: string
	/** 保留其它字段 */
	[key: string]: unknown
}

/**
 * 模型文件快照
 */
export interface HardwareModelSnapshot {
	/** 模型标识 */
	model_id: string
	/** 模型版本 */
	version: string
	/** 额外参数 */
	arguments: {
		/** 模型下载地址 */
		url: string
		/** 模型图标地址 */
		icon?: string
		/** 保留其它字段 */
		[key: string]: unknown
	}
	/** 校验和 */
	checksum?: string
	/** 模型格式 */
	model_format: string
	/** AI 框架 */
	ai_framwork: string
	/** 保留其它字段 */
	[key: string]: unknown
}

/**
 * 模型详情
 */
export interface HardwareModelDetailInfo {
	/** 模型名称 */
	name: string
	/** 作者名称 */
	author_name: string
	/** 标签列表 */
	labels?: Array<{ object_name: string }>
	/** 保留其它字段 */
	[key: string]: unknown
}

/**
 * 固件远端请求参数
 */
export interface HardwareFirmwareRequest {
	/** 应用配置 */
	config?: AilyAppConfig
	/** 固件类型 */
	firmwareType: HardwareFirmwareType
	/** 固件版本 */
	version?: string | null
}

/**
 * 模型元数据请求参数
 */
export interface HardwareModelFileRequest {
	/** 应用配置 */
	config?: AilyAppConfig
	/** 模型标识 */
	modelId: string
}
