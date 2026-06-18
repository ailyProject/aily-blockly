import { r } from '../trpc'
import {
	addApp,
	createDefaultLayout,
	mergeVisibleOrder,
	removeApp,
	reset,
	resolveLayout,
	setLayout,
	toggleApp
} from './layout'

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
