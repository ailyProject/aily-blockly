import { createAilyCoreServiceAddress } from '@shared'

import type { AilyCoreServiceHealth } from '@shared'
import type { CreateAilyCoreRouterOptions } from './types'

/**
 * 构造 Core 服务健康状态快照
 * @param options - 服务运行时元数据
 */
export const createAilyCoreServiceHealth = (options: CreateAilyCoreRouterOptions): AilyCoreServiceHealth => ({
	name: 'aily-core',
	status: 'ok',
	version: options.version,
	transport: options.transport ?? 'http',
	startedAt: new Date(options.startedAt).toISOString(),
	uptimeMs: Math.max(0, Date.now() - options.startedAt),
	address: createAilyCoreServiceAddress(options.address)
})
