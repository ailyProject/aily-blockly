import { resolveCoreServiceBaseUrl } from '@ui/core-service/config'

import type { CreateAgentApiOptions } from './types'

/**
 * 解析 agent session API 地址。
 * @param options - 地址覆盖项
 */
export const resolveAgentSessionApi = (options: CreateAgentApiOptions = {}) =>
	`${resolveCoreServiceBaseUrl({ baseUrl: options.baseUrl })}/api/agent/session`
