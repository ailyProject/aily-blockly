import { config } from '@/workspace'

import type { Core } from '@/core-service'

/**
 * 加载模型目录列表。
 * @param {Core} core - core 服务句柄
 * @param {{search?: string, page?: number, pageSize?: number, uniformType?: string}} [query] - 模型目录查询参数
 * @returns {Promise<Awaited<ReturnType<Core['model']['list']['query']>>>}
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
