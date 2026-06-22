import { getTRPCErrorShape, transformTRPCResponse, TRPCError } from '@trpc/server'

import { ERPC_CHANNEL } from '../constants'

import type { AnyTRPCRouter, inferRouterContext } from '@trpc/server'
import type { TRPCResponseMessage } from '@trpc/server/rpc'
import type { IpcMainEvent } from 'electron'

type TRPCProcedureKind = 'query' | 'mutation' | 'subscription' | 'unknown'

/**
 * 创建当前 IPC 请求的统一响应函数。
 * @param router - tRPC 路由
 * @param event - Electron IPC 事件
 */
export const createIPCResponder =
	<TRouter extends AnyTRPCRouter>(router: TRouter, event: IpcMainEvent) =>
	(response: TRPCResponseMessage) => {
		if (event.sender.isDestroyed()) return
		event.reply(ERPC_CHANNEL, transformTRPCResponse(router._def._config, response))
	}

/**
 * 发送 tRPC 错误响应。
 * @param input - 错误上下文
 */
export const respondWithTRPCError = <TRouter extends AnyTRPCRouter>(input: {
	router: TRouter
	respond: (response: TRPCResponseMessage) => void
	id: number | string | null
	type: TRPCProcedureKind
	path: string
	input: unknown
	ctx: inferRouterContext<TRouter>
	error: TRPCError
}) =>
	input.respond({
		id: input.id,
		error: getTRPCErrorShape({
			config: input.router._def._config,
			error: input.error,
			type: input.type,
			path: input.path,
			input: input.input,
			ctx: input.ctx
		})
	})
