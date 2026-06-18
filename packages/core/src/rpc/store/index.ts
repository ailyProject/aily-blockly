import { r } from '../trpc'
import { default as addApp } from './addApp'
import { default as createDefaultLayout } from './createDefaultLayout'
import { default as mergeVisibleOrder } from './mergeVisibleOrder'
import { default as removeApp } from './removeApp'
import { default as reset } from './reset'
import { default as resolveLayout } from './resolveLayout'
import { default as setLayout } from './setLayout'
import { default as toggleApp } from './toggleApp'

export default r({
	resolveLayout,
	createDefaultLayout,
	mergeVisibleOrder,
	setLayout,
	addApp,
	removeApp,
	toggleApp,
	reset
})
