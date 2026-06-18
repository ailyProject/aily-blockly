import { ETRPCRequest } from '../types'
import { CreateContextOptions } from './types'

import type { AnyTRPCRouter, inferRouterContext } from '@trpc/server'
import type { IpcMainEvent } from 'electron'

export declare function handleIPCMessage<TRouter extends AnyTRPCRouter>({
	router,
	createContext,
	internalId,
	message,
	event,
	subscriptions
}: {
	router: TRouter
	createContext?: (opts: CreateContextOptions) => Promise<inferRouterContext<TRouter>>
	internalId: string
	message: ETRPCRequest
	event: IpcMainEvent
	subscriptions: Map<string, AbortController>
}): Promise<void>
