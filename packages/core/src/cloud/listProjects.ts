import { listOwnedCloudProjects } from './remote'

import type { CloudProjectListQuery } from './types'

/**
 * 获取当前登录用户的云项目列表。
 * @param query - 查询参数
 * @param authToken - Bearer token
 */
export const listCloudProjects = (query: CloudProjectListQuery | undefined, authToken: string) =>
	listOwnedCloudProjects(query, authToken)
