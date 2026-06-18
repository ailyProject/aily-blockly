import { randomUUID } from 'node:crypto'
import { initTRPC } from '@trpc/server'

import type { AilyCoreServiceContext } from './types'

const t = initTRPC.context<AilyCoreServiceContext>().create({ isServer: true })

export const p = t.procedure
export const r = t.router

/**
 * 为每次 HTTP / tRPC 请求创建最小上下文
 * @param startedAt - 服务启动时间戳
 */
export const createAilyCoreServiceContext = (startedAt: number): AilyCoreServiceContext => ({
	requestId: randomUUID(),
	startedAt
})
