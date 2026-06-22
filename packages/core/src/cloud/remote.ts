import { normalizeCloudProjectSummary } from './normalize'
import {
	AILY_CLOUD_PROJECT_TEMPLATES_PATH,
	AILY_CLOUD_PROJECTS_PATH,
	AILY_CLOUD_PUBLIC_PROJECTS_PATH,
	requestCloudProjectList,
	resolveCloudApiBase
} from './request'

import type { CloudProjectListResult } from 'shared'
import type { CloudProjectListQuery } from './types'

const listCloudProjects = async (
	scope: CloudProjectListResult['scope'],
	path: string,
	query: CloudProjectListQuery = {},
	authToken?: string
): Promise<CloudProjectListResult> => {
	const apiBase = resolveCloudApiBase()
	const { page, pageSize, payload } = await requestCloudProjectList(path, query, authToken)
	if (payload.status !== 200 && payload.status !== '200') {
		throw new Error('Cloud response rejected')
	}

	const items = (payload.data?.list ?? []).map(item => normalizeCloudProjectSummary(item, apiBase))
	return {
		scope,
		page,
		pageSize,
		total: Number(payload.data?.total ?? items.length),
		items
	}
}

/**
 * 获取公开云项目列表。
 * @param query - 查询参数
 */
export const listPublicCloudProjects = (query?: CloudProjectListQuery) =>
	listCloudProjects('public', AILY_CLOUD_PUBLIC_PROJECTS_PATH, query)

/**
 * 获取模板项目列表。
 * @param query - 查询参数
 */
export const listCloudTemplates = (query?: CloudProjectListQuery, authToken?: string) =>
	listCloudProjects('template', AILY_CLOUD_PROJECT_TEMPLATES_PATH, query, authToken)

/**
 * 获取当前用户的云项目列表。
 * @param query - 查询参数
 * @param authToken - Bearer token
 */
export const listOwnedCloudProjects = (query: CloudProjectListQuery | undefined, authToken: string) =>
	listCloudProjects('mine', AILY_CLOUD_PROJECTS_PATH, query, authToken)
