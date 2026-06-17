import { TRPCClientError } from '@trpc/client'
import { getTransformer } from '@trpc/client/unstable-internals'
import { observable } from '@trpc/server/observable'

import { transformResult } from './utils'

import type { Operation, TRPCLink } from '@trpc/client'
import type { TransformerOptions } from '@trpc/client/unstable-internals'
import type { AnyTRPCRouter, inferRouterContext, inferTRPCClientTypes, TRPCProcedureType } from '@trpc/server'
import type { Observer } from '@trpc/server/observable'
import type { TRPCResponseMessage } from '@trpc/server/rpc'
import type { GlobalERPC } from '../types'

type IPCCallbackResult<TRouter extends AnyTRPCRouter = AnyTRPCRouter> = TRPCResponseMessage<
	unknown,
	inferRouterContext<TRouter>
>

type IPCCallbacks<TRouter extends AnyTRPCRouter = AnyTRPCRouter> = Observer<
	IPCCallbackResult<TRouter>,
	TRPCClientError<TRouter>
>

type IPCRequest = {
	type: TRPCProcedureType
	callbacks: IPCCallbacks
	op: Operation
}

const getElectronTRPC = () => {
	const ERPC: GlobalERPC = (globalThis as any).$erpc

	if (!ERPC) {
		throw new Error(
			'Could not find `ERPC` global. Check that `exposeElectronTRPC` has been called in your preload file.'
		)
	}

	return ERPC
}

class IPCClient {
	#pendingRequests = new Map<string | number, IPCRequest>()
	#ERPC = getElectronTRPC()

	constructor() {
		this.#ERPC.onMessage((response: TRPCResponseMessage) => {
			this.#handleResponse(response)
		})
	}

	#handleResponse(response: TRPCResponseMessage) {
		const request = response.id && this.#pendingRequests.get(response.id)
		if (!request) {
			return
		}

		request.callbacks.next(response)

		if ('result' in response && response.result.type === 'stopped') {
			request.callbacks.complete()
		}
	}

	request(op: Operation, callbacks: IPCCallbacks) {
		const { type, id } = op

		this.#pendingRequests.set(id, {
			type,
			callbacks,
			op
		})

		this.#ERPC.sendMessage({ method: 'request', operation: op })

		return () => {
			const callbacks = this.#pendingRequests.get(id)?.callbacks

			this.#pendingRequests.delete(id)

			callbacks?.complete()

			if (type === 'subscription') {
				this.#ERPC.sendMessage({
					id,
					method: 'subscription.stop'
				})
			}
		}
	}
}

export type IPCLinkOptions<TRouter extends AnyTRPCRouter> = TransformerOptions<inferTRPCClientTypes<TRouter>>

export function ipcLink<TRouter extends AnyTRPCRouter>(opts?: IPCLinkOptions<TRouter>): TRPCLink<TRouter> {
	return () => {
		const client = new IPCClient()
		const transformer = getTransformer(opts?.transformer)

		return ({ op }) => {
			return observable(observer => {
				op.input = transformer.input.serialize(op.input)

				const unsubscribe = client.request(op, {
					error(err) {
						observer.error(err as TRPCClientError<any>)
						unsubscribe()
					},
					complete() {
						observer.complete()
					},
					next(response) {
						const transformed = transformResult(response, transformer.output)

						if (!transformed.ok) {
							observer.error(TRPCClientError.from(transformed.error))
							return
						}

						observer.next({ result: transformed.result })

						if (op.type !== 'subscription') {
							unsubscribe()
							observer.complete()
						}
					}
				})

				return () => {
					unsubscribe()
				}
			})
		}
	}
}
