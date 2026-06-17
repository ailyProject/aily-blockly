import {
	callTRPCProcedure,
	getTRPCErrorFromUnknown,
	getTRPCErrorShape,
	isTrackedEnvelope,
	transformTRPCResponse,
	TRPCError
} from '@trpc/server'
import { isObservable, observableToAsyncIterable } from '@trpc/server/observable'

import { ERPC_CHANNEL } from '../constants'
import { ETRPCRequest } from '../types'
import { Unpromise } from '../vendor/unpromise'
import { CreateContextOptions } from './types'
import { isAsyncIterable, iteratorResource, run } from './utils'

import type { AnyTRPCRouter, inferRouterContext } from '@trpc/server'
import type { TRPCResponseMessage, TRPCResultMessage } from '@trpc/server/rpc'
import type { IpcMainEvent } from 'electron'

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

	const { type, input: serializedInput, path, id } = message.operation
	const input = serializedInput ? router._def._config.transformer.input.deserialize(serializedInput) : undefined

	const ctx = (await createContext?.({ event })) ?? {}

	const respond = (response: TRPCResponseMessage) => {
		if (event.sender.isDestroyed()) return
		event.reply(ERPC_CHANNEL, transformTRPCResponse(router._def._config, response))
	}

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

		if (!isIterableResult) {
			throw new TRPCError({
				message: `Subscription ${path} did not return an observable or a AsyncGenerator`,
				code: 'INTERNAL_SERVER_ERROR'
			})
		}

		if (subscriptions.has(internalId)) {
			// duplicate request ids for client

			throw new TRPCError({
				message: `Duplicate id ${internalId}`,
				code: 'BAD_REQUEST'
			})
		}

		const iterable = isObservable(result) ? observableToAsyncIterable(result, abortController.signal) : result

		run(async () => {
			await using iterator = iteratorResource(iterable)

			const abortPromise = new Promise<'abort'>(resolve => {
				abortController.signal.onabort = () => resolve('abort')
			})
			// We need those declarations outside the loop for garbage collection reasons. If they
			// were declared inside, they would not be freed until the next value is present.
			let next: null | TRPCError | Awaited<typeof abortPromise | ReturnType<(typeof iterator)['next']>>
			let result: null | TRPCResultMessage<unknown>['result']

			while (true) {
				next = await Unpromise.race([iterator.next().catch(getTRPCErrorFromUnknown), abortPromise])

				if (next === 'abort') {
					await iterator.return?.()
					break
				}
				if (next instanceof Error) {
					const error = getTRPCErrorFromUnknown(next)
					respond({
						id,
						error: getTRPCErrorShape({
							config: router._def._config,
							error,
							type,
							path,
							input,
							ctx
						})
					})
					break
				}
				if (next.done) {
					break
				}

				result = {
					type: 'data',
					data: next.value
				}

				if (isTrackedEnvelope(next.value)) {
					const [id, data] = next.value
					result.id = id
					result.data = {
						id,
						data
					}
				}

				respond({
					id,
					result
				})

				// free up references for garbage collection
				next = null
				result = null
			}

			respond({
				id,
				result: {
					type: 'stopped'
				}
			})
			subscriptions.delete(internalId)
		}).catch(cause => {
			const error = getTRPCErrorFromUnknown(cause)
			respond({
				id,
				error: getTRPCErrorShape({
					config: router._def._config,
					error,
					type,
					path,
					input,
					ctx
				})
			})
			abortController.abort()
		})

		respond({
			id,
			result: {
				type: 'started'
			}
		})
		subscriptions.set(internalId, abortController)
	} catch (cause) {
		const error: TRPCError = getTRPCErrorFromUnknown(cause)

		return respond({
			id,
			error: getTRPCErrorShape({
				config: router._def._config,
				error,
				type,
				path,
				input,
				ctx
			})
		})
	}
}
