import { r } from '../trpc'
import { default as buildSerialConnectOptions } from './buildSerialConnectOptions'
import { default as get } from './get'
import { default as getStored } from './getStored'
import { default as resolveModel } from './model'
import { default as previewUpdate } from './previewUpdate'
import { default as updateStored } from './updateStored'

export * from './types'

export default r({
	get,
	getStored,
	resolveModel,
	previewUpdate,
	updateStored,
	buildSerialConnectOptions
})
