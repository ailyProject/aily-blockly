import { getTRPCErrorFromUnknown, isTrackedEnvelope, TRPCError } from '@trpc/server'
import { isObservable, observableToAsyncIterable } from '@trpc/server/observable'

import { respondWithTRPCError } from './handleIPCShared'
import { isAsyncIterable, iteratorResource, run } from './utils'

import type { AnyTRPCRouter, inferRouterContext } from '@trpc/server'
import type { TRPCResponseMessage, TRPCResultMessage } from '@trpc/server/rpc'

/**
 * 处理订阅型 IPC 请求。
 * @param input - 订阅处理上下文
 */
export const handleIPCSubscription = async <TRouter extends AnyTRPCRouter>(input: {
	router: TRouter
	respond: (response: TRPCResponseMessage) => void
	internalId: string
	id: number | string | null
	type: 'query' | 'mutation' | 'subscription' | 'unknown'
	path: string
	rawInput: unknown
	ctx: inferRouterContext<TRouter>
	subscriptions: Map<string, AbortController>
	result: unknown
}) => {
	const abortController = new AbortController()
	const { respond, id } = input

	const isIterableResult = isAsyncIterable(input.result) || isObservable(input.result)
	if (!isIterableResult) {
		throw new TRPCError({
			message: `Subscription ${input.path} did not return an observable or a AsyncGenerator`,
			code: 'INTERNAL_SERVER_ERROR'
		})
	}

	if (input.subscriptions.has(input.internalId)) {
		throw new TRPCError({
			message: `Duplicate id ${input.internalId}`,
			code: 'BAD_REQUEST'
		})
	}

	const iterable = isObservable(input.result)
		? observableToAsyncIterable(input.result, abortController.signal)
		: (input.result as AsyncIterable<unknown>)

	run(async () => {
		await using iterator = iteratorResource(iterable)

		const abortPromise = new Promise<'abort'>(resolve => {
			abortController.signal.onabort = () => resolve('abort')
		})
		let next: null | TRPCError | Awaited<typeof abortPromise | ReturnType<(typeof iterator)['next']>>
		let result: null | TRPCResultMessage<unknown>['result']

		while (true) {
			next = await Promise.race([iterator.next().catch(getTRPCErrorFromUnknown), abortPromise])

			if (next === 'abort') {
				await iterator.return?.()
				break
			}
			if (next instanceof Error) {
				const error = getTRPCErrorFromUnknown(next)
				respondWithTRPCError({
					router: input.router,
					respond,
					id,
					type: input.type,
					path: input.path,
					input: input.rawInput,
					ctx: input.ctx,
					error
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
				const [trackedId, data] = next.value
				result.id = trackedId
				result.data = {
					id: trackedId,
					data
				}
			}

			respond({
				id,
				result
			})

			next = null
			result = null
		}

		respond({
			id,
			result: {
				type: 'stopped'
			}
		})
		input.subscriptions.delete(input.internalId)
	}).catch(cause => {
		const error = getTRPCErrorFromUnknown(cause)
		respondWithTRPCError({
			router: input.router,
			respond,
			id,
			type: input.type,
			path: input.path,
			input: input.rawInput,
			ctx: input.ctx,
			error
		})
		abortController.abort()
	})

	respond({
		id,
		result: {
			type: 'started'
		}
	})
	input.subscriptions.set(input.internalId, abortController)
}
