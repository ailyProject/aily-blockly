import { config } from '@/workspace'

import type { Core } from '@/utils/core'

/**
 * 加载模型目录列表。
 * @param core - core 服务句柄
 * @param query - 模型目录查询参数
 */
export const loadModelCatalog = (
	core: Core,
	query: { search?: string; page?: number; pageSize?: number; uniformType?: string } = {}
) =>
	core.model.list.query({
		config,
		page: query.page,
		pageSize: query.pageSize,
		search: query.search,
		uniformType: query.uniformType
	})
