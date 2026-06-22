import { resolveCoreBaseUrl } from '@/utils/core'

import type { CreateAgentApiOptions } from './types'

/**
 * 解析 agent session API 地址。
 * @param options - 地址覆盖项
 */
export const resolveAgentSessionApi = (options: CreateAgentApiOptions = {}) =>
	`${resolveCoreBaseUrl({ baseUrl: options.baseUrl })}/api/agent/session`
