import type { CloudProjectListQuery, CloudProjectMetadata } from 'shared'

/**
 * 云项目列表查询输入。
 */
export interface CloudProjectListRequest {
	/** 查询参数。 */
	query?: CloudProjectListQuery
	/** 认证 token；用于读取当前用户项目或模板。 */
	authToken?: string
}

/**
 * 云项目状态动作输入。
 */
export interface CloudProjectMutationInput {
	/** 目标云项目 ID。 */
	projectId: string
	/** 用于访问用户项目接口的 Bearer token。 */
	authToken: string
}

/**
 * 云项目同步输入。
 */
export interface CloudProjectSyncInput {
	/** 已存在云项目时复用的项目 ID。 */
	projectId?: string
	/** 需要发送给云端的项目元数据。 */
	projectData: Record<string, unknown>
	/** 可选归档文件路径。 */
	archivePath?: string
	/** 当前用户访问云接口的 Bearer token。 */
	authToken: string
}

/**
 * 云项目基础信息更新输入。
 */
export interface CloudProjectUpdateInput extends CloudProjectMetadata {
	/** 需要更新的云项目 ID。 */
	projectId: string
	/** 当前用户访问云接口的 Bearer token。 */
	authToken: string
	/** Base64 编码后的封面图字节。 */
	imageBase64?: string
	/** 封面图文件名。 */
	imageName?: string
	/** 是否显式请求清空封面。当前仍待服务端语义确认。 */
	removeCover?: boolean
}

/**
 * 云端原始项目条目。
 */
export interface RemoteCloudProjectItem {
	/** 云项目 ID。 */
	id?: string | number
	/** 项目名称。 */
	name?: string
	/** 用户昵称。 */
	nickname?: string
	/** 项目描述。 */
	description?: string
	/** 项目文档链接。 */
	doc_url?: string
	/** 封面图路径。 */
	image_url?: string
	/** 归档路径。 */
	archive_url?: string
	/** 板卡标识。 */
	board?: string
	/** 标签 JSON 或数组。 */
	tags?: string | Array<string>
	/** 是否为模板。 */
	is_template?: boolean
	/** 是否已公开。 */
	is_published?: boolean
}

/**
 * 云端项目列表响应。
 */
export interface RemoteCloudProjectListResponse {
	/** 响应状态码。 */
	status?: number | string
	/** 响应数据体。 */
	data?: {
		/** 项目列表。 */
		list?: Array<RemoteCloudProjectItem>
		/** 总条目数。 */
		total?: number
	}
}

/**
 * 云项目状态动作接口响应。
 */
export interface RemoteCloudProjectMutationResponse {
	/** 响应状态码。 */
	status?: number | string
	/** 服务端返回消息。 */
	message?: string
	/** 可选数据体。 */
	data?: unknown
}

/**
 * 云项目同步接口响应。
 */
export interface RemoteCloudProjectSyncResponse {
	/** 响应状态码。 */
	status?: number | string
	/** 服务端返回消息。 */
	message?: string
	/** 同步后的项目数据。 */
	data?: {
		/** 云项目 ID。 */
		id?: string | number
		/** 保留其它字段。 */
		[key: string]: unknown
	}
}

export type {
	CloudProjectListQuery,
	CloudProjectListResult,
	CloudProjectMutationAction,
	CloudProjectMutationResult,
	CloudProjectSummary,
	CloudProjectSyncResult
} from 'shared'
