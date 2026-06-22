import { createCloudHeaders, resolveCloudApiBase } from './shared'

import type { CloudProjectListQuery, RemoteCloudProjectListResponse } from '../types'

/**
 * 规整云项目分页参数。
 * @param value - 当前页码或每页数量
 * @param fallback - 默认值
 */
export const normalizeCloudPage = (value: number | undefined, fallback: number) =>
	value && value > 0 ? value : fallback

/**
 * 构造云项目列表查询字符串。
 * @param query - 列表查询参数
 */
export const createCloudListQuery = (query: CloudProjectListQuery = {}) => {
	const page = normalizeCloudPage(query.page, 1)
	const pageSize = normalizeCloudPage(query.pageSize, 20)
	const params = new URLSearchParams({
		page: String(page),
		perPage: String(pageSize),
		keywords: query.search ?? '',
		id: query.id ?? '',
		board: query.board ?? ''
	})

	return {
		page,
		pageSize,
		params
	}
}

/**
 * 拉取并解析云项目列表接口。
 * @param path - 云接口路径
 * @param query - 查询参数
 * @param authToken - 可选 Bearer token
 */
export const requestCloudProjectList = async (
	path: string,
	query: CloudProjectListQuery = {},
	authToken?: string
): Promise<{ page: number; pageSize: number; payload: RemoteCloudProjectListResponse }> => {
	const apiBase = resolveCloudApiBase()
	const { page, pageSize, params } = createCloudListQuery(query)
	const response = await fetch(`${apiBase}${path}?${params.toString()}`, {
		headers: createCloudHeaders(authToken)
	})
	if (!response.ok) {
		throw new Error(`Cloud request failed: ${response.status}`)
	}

	return {
		page,
		pageSize,
		payload: (await response.json()) as RemoteCloudProjectListResponse
	}
}
