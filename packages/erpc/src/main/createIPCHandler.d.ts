import { CreateContextOptions } from './types'

import type { AnyTRPCRouter, inferRouterContext } from '@trpc/server'
import type { BrowserWindow } from 'electron'

type MaybePromise<TType> = Promise<TType> | TType
declare class IPCHandler<TRouter extends AnyTRPCRouter> {
	#private
	constructor({
		createContext,
		router,
		windows
	}: {
		createContext?: (opts: CreateContextOptions) => MaybePromise<inferRouterContext<TRouter>>
		router: TRouter
		windows?: BrowserWindow[]
	})
	attachWindow(win: BrowserWindow): void
	detachWindow(win: BrowserWindow, webContentsId?: number): void
}
export declare const createIPCHandler: <TRouter extends AnyTRPCRouter>({
	createContext,
	router,
	windows
}: {
	createContext?: (opts: CreateContextOptions) => Promise<inferRouterContext<TRouter>>
	router: TRouter
	windows?: BrowserWindow[]
}) => IPCHandler<TRouter>
export {}
