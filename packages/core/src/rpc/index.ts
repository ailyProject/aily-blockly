import agent from './agent'
import build from './build'
import config from './config/index'
import connection from './connection/index'
import document from './document'
import ffs from './ffs/index'
import hardware from './hardware'
import { createAilyCoreServiceHealth } from './health'
import model from './model/index'
import onboarding from './onboarding/index'
import project from './project'
import store from './store/index'
import tool from './tool/index'
import { p, r } from './trpc'

import type { CreateAilyCoreRouterOptions } from './types'

export { default as agent } from './agent'
export { default as build } from './build'
export { default as connection } from './connection/index'
export { default as config } from './config/index'
export { default as document } from './document'
export { default as ffs } from './ffs/index'
export * from './health'
export { default as hardware } from './hardware'
export { default as model } from './model/index'
export { default as onboarding } from './onboarding/index'
export { default as project } from './project'
export { default as store } from './store/index'
export { default as tool } from './tool/index'
export * from './server'
export * from './standalone'
export * from './trpc'
export * from './types'

export const router = (options: CreateAilyCoreRouterOptions) =>
	r({
		agent,
		config,
		health: p.query(() => createAilyCoreServiceHealth(options)),
		build,
		connection,
		document,
		ffs,
		hardware,
		model,
		onboarding,
		project,
		store,
		tool
	})
