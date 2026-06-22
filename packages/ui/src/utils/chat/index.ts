import { inject, InjectionToken, makeEnvironmentProviders } from '@angular/core'

import { createAgentApi } from './transport'

import type { AgentApi, CreateAgentApiOptions } from './types'

export * from './config'
export * from './chat-transport'
export * from './transport'
export * from './types'

export const AGENT_API = new InjectionToken<AgentApi>('AGENT_API')

/**
 * 注册全局 agent API 句柄 provider。
 * @param options - 地址覆盖项
 */
export function provideAgentApi(options: CreateAgentApiOptions = {}) {
	return makeEnvironmentProviders([
		{
			provide: AGENT_API,
			useFactory: () => createAgentApi(options)
		}
	])
}

/**
 * 在 Angular 注入上下文中读取 agent API 句柄。
 */
export const injectAgentApi = () => inject(AGENT_API)
