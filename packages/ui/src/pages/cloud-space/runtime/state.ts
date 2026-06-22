import { projectNewSeparator, projectNewUserDocuments } from '../../project-new/data'

import type { Core } from '@/utils/core'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { CloudProjectScope } from 'shared'
import type { CloudSpacePageState } from '../types'

/**
 * 创建一个空的 Cloud Space 页面状态。
 * @param scope - 当前列表作用域
 * @param requiresAuth - 当前作用域是否要求先提供 token
 */
export const createEmptyCloudSpacePageState = (
	scope: CloudProjectScope,
	requiresAuth = false
): CloudSpacePageState => ({
	scope,
	requiresAuth,
	items: [],
	page: 1,
	pageSize: 20,
	total: 0
})

/**
 * 读取 Cloud Space 页面列表状态。
 * @param core - Core tRPC 句柄
 * @param options - 页面筛选条件与认证信息
 */
export const loadCloudSpacePageState = async (
	core: Core,
	options: {
		page?: number
		pageSize?: number
		search?: string
		board?: string
		scope?: CloudProjectScope
		authToken?: string
	} = {}
): Promise<CloudSpacePageState> => {
	const scope = options.scope ?? 'public'
	const authToken = options.authToken?.trim()
	if (scope === 'mine' && !authToken) {
		return createEmptyCloudSpacePageState('mine', true)
	}

	const query = {
		page: options.page ?? 1,
		pageSize: options.pageSize ?? 20,
		search: options.search,
		board: options.board
	}
	const result =
		scope === 'template'
			? await core.cloud.listTemplates.query({ ...query, ...(authToken ? { authToken } : {}) })
			: scope === 'mine'
				? await core.cloud.listProjects.query({ ...query, authToken: authToken! })
				: await core.cloud.listPublicProjects.query(query)

	return {
		scope: result.scope,
		requiresAuth: false,
		items: result.items,
		page: result.page,
		pageSize: result.pageSize,
		total: result.total
	}
}

/**
 * 读取 Cloud Space 默认导入根目录。
 * @param core - Core tRPC 句柄
 * @param runtimeInfo - desktop 运行时信息
 */
export const loadCloudSpaceRootPath = (core: Core, runtimeInfo: DesktopHostRuntimeInfo | null) =>
	core.project.getDefaultProjectRootPath.query({
		userDocuments: runtimeInfo?.documentsPath || projectNewUserDocuments,
		separator: runtimeInfo?.pathSeparator || projectNewSeparator
	})
