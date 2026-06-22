import { callTRPCProcedure, getTRPCErrorFromUnknown, TRPCError } from '@trpc/server'
import { isObservable } from '@trpc/server/observable'

import { createIPCResponder, respondWithTRPCError } from './handleIPCShared'
import { handleIPCSubscription } from './handleIPCSubscription'
import { isAsyncIterable } from './utils'

import type { AnyTRPCRouter, inferRouterContext } from '@trpc/server'
import type { IpcMainEvent } from 'electron'
import type { ETRPCRequest } from '../types'
import type { CreateContextOptions } from './types'

type TRPCProcedureKind = 'query' | 'mutation' | 'subscription'

export async function handleIPCMessage<TRouter extends AnyTRPCRouter>({
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
}) {
	if (message.method === 'subscription.stop') {
		subscriptions.get(internalId)?.abort()
		return
	}

	const { input: serializedInput, path, id } = message.operation
	const type = message.operation.type as TRPCProcedureKind
	const input = serializedInput ? router._def._config.transformer.input.deserialize(serializedInput) : undefined
	const ctx = (await createContext?.({ event })) ?? {}
	const respond = createIPCResponder(router, event)

	try {
		const abortController = new AbortController()
		const result = await callTRPCProcedure({
			ctx,
			path,
			type,
			signal: abortController.signal,
			router,
			batchIndex: 0,
			getRawInput: async () => input
		})

		const isIterableResult = isAsyncIterable(result) || isObservable(result)
		if (type !== 'subscription') {
			if (isIterableResult) {
				throw new TRPCError({
					code: 'UNSUPPORTED_MEDIA_TYPE',
					message: `Cannot return an async iterable or observable from a ${type} procedure.`
				})
			}

			respond({
				id,
				result: {
					type: 'data',
					data: result
				}
			})
			return
		}

		await handleIPCSubscription({
			router,
			respond,
			internalId,
			id,
			type,
			path,
			rawInput: input,
			ctx,
			subscriptions,
			result
		})
	} catch (cause) {
		const error = getTRPCErrorFromUnknown(cause)
		return respondWithTRPCError({
			router,
			respond,
			id,
			type,
			path,
			input,
			ctx,
			error
		})
	}
}
