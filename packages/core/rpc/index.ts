import agent from './agent'
import app from './app'
import build from './build'
import document from './document'
import hardware from './hardware'
import { createAilyCoreServiceHealth } from './health'
import project from './project'
import { p, r } from './trpc'

import type { CreateAilyCoreRouterOptions } from './types'

export { default as agent } from './agent'
export { default as app } from './app'
export { default as build } from './build'
export { default as document } from './document'
export * from './health'
export { default as hardware } from './hardware'
export { default as project } from './project'
export * from './server'
export * from './standalone'
export * from './trpc'
export * from './types'

export const router = (options: CreateAilyCoreRouterOptions) =>
	r({
		app,
		agent,
		health: p.query(() => createAilyCoreServiceHealth(options)),
		build,
		document,
		hardware,
		project
	})
