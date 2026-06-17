import { ipcMain } from 'electron'

import { ERPC_CHANNEL } from '../constants'
import { ETRPCRequest } from '../types'
import { handleIPCMessage } from './handleIPCMessage'
import { CreateContextOptions } from './types'

import type { AnyTRPCRouter, inferRouterContext } from '@trpc/server'
import type { BrowserWindow, IpcMainEvent } from 'electron'

type MaybePromise<TType> = Promise<TType> | TType

const getInternalId = (event: IpcMainEvent, request: ETRPCRequest) => {
	const messageId = request.method === 'request' ? request.operation.id : request.id

	if (event.senderFrame) {
		return `${event.sender.id}-${event.senderFrame.routingId}:${messageId}`
	} else {
		throw new Error('No sender frame')
	}
}

class IPCHandler<TRouter extends AnyTRPCRouter> {
	#windows: BrowserWindow[] = []
	#subscriptions: Map<string, AbortController> = new Map()

	constructor({
		createContext,
		router,
		windows = []
	}: {
		createContext?: (opts: CreateContextOptions) => MaybePromise<inferRouterContext<TRouter>>
		router: TRouter
		windows?: BrowserWindow[]
	}) {
		windows.forEach(win => this.attachWindow(win))

		ipcMain.on(ERPC_CHANNEL, (event: IpcMainEvent, request: ETRPCRequest) => {
			handleIPCMessage({
				router,
				createContext,
				internalId: getInternalId(event, request),
				event,
				message: request,
				subscriptions: this.#subscriptions
			})
		})
	}

	attachWindow(win: BrowserWindow) {
		if (this.#windows.includes(win)) {
			return
		}

		this.#windows.push(win)
		this.#attachSubscriptionCleanupHandlers(win)
	}

	detachWindow(win: BrowserWindow, webContentsId?: number) {
		this.#windows = this.#windows.filter(w => w !== win)

		if (win.isDestroyed() && webContentsId === undefined) {
			throw new Error('webContentsId is required when calling detachWindow on a destroyed window')
		}

		this.#cleanUpSubscriptions({
			webContentsId: webContentsId ?? win.webContents.id
		})
	}

	#cleanUpSubscriptions({ webContentsId, frameRoutingId }: { webContentsId: number; frameRoutingId?: number }) {
		for (const [key, sub] of this.#subscriptions.entries()) {
			if (key.startsWith(`${webContentsId}-${frameRoutingId ?? ''}`)) {
				sub.abort()
				this.#subscriptions.delete(key)
			}
		}
	}

	#attachSubscriptionCleanupHandlers(win: BrowserWindow) {
		const webContentsId = win.webContents.id

		win.webContents.on('did-start-navigation', ({ isSameDocument, frame }) => {
			if (!isSameDocument) {
				this.#cleanUpSubscriptions({
					webContentsId: webContentsId,
					frameRoutingId: frame.routingId
				})
			}
		})

		win.webContents.on('destroyed', () => {
			this.detachWindow(win, webContentsId)
		})
	}
}

export const createIPCHandler = <TRouter extends AnyTRPCRouter>({
	createContext,
	router,
	windows = []
}: {
	createContext?: (opts: CreateContextOptions) => Promise<inferRouterContext<TRouter>>
	router: TRouter
	windows?: BrowserWindow[]
}) => {
	return new IPCHandler({ createContext, router, windows })
}
