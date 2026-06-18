import { serve } from '@hono/node-server'
import { trpcServer } from '@hono/trpc-server'
import { Hono } from 'hono'
import { createAilyCoreServiceAddress } from 'shared'

import { router } from '.'
import api from '../api'
import { createAilyCoreServiceHealth } from './health'
import { createAilyCoreServiceContext } from './trpc'

import type { AilyCoreServiceHandle, CreateAilyCoreRouterOptions, CreateAilyCoreServerOptions } from './types'

/**
 * 创建可独立启动的 Core HTTP / tRPC 服务
 * @param options - 服务启动选项
 */
export const createAilyCoreServer = (options: CreateAilyCoreServerOptions = {}): AilyCoreServiceHandle => {
	const startedAt = Date.now()
	const address = createAilyCoreServiceAddress(options)
	const runtime: CreateAilyCoreRouterOptions = {
		version: options.version ?? '0.0.0',
		startedAt,
		address,
		transport: options.transport ?? 'http'
	}
	const routes = router(runtime)
	const app = new Hono()
	let nodeServer: { close(callback?: () => void): void } | null = null

	app.get(address.healthPath, c => c.json(createAilyCoreServiceHealth(runtime)))
	app.route('/api/agent', api)
	app.use(
		`${address.trpcPath}/*`,
		trpcServer({
			router: routes,
			createContext: async () => createAilyCoreServiceContext(startedAt)
		})
	)

	return {
		address,
		start: async () => {
			if (nodeServer) return address

			await new Promise<void>(resolve => {
				nodeServer = serve(
					{
						fetch: app.fetch,
						hostname: address.host,
						port: address.port
					},
					() => resolve()
				)
			})

			return address
		},
		stop: async () => {
			if (!nodeServer) return

			await new Promise<void>(resolve => {
				nodeServer?.close(() => resolve())
			})
			nodeServer = null
		},
		getHealthSnapshot: () => createAilyCoreServiceHealth(runtime)
	}
}
