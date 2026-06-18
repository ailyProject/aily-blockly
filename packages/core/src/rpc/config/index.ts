import { r } from '../trpc'
import { default as buildSerialConnectOptions } from './buildSerialConnectOptions'
import { default as clearSkippedVersions } from './clearSkippedVersions'
import { default as get } from './get'
import { default as resolveModel } from './model'
import { default as previewUpdate } from './previewUpdate'
import { default as setDevmode } from './setDevmode'
import { default as setDevmodeAutoSave } from './setDevmodeAutoSave'
import { default as setLanguage } from './setLanguage'
import { default as setModel } from './setModel'
import { default as setQuickSends } from './setQuickSends'
import { default as setSerialMonitor } from './setSerialMonitor'
import { default as setTheme } from './setTheme'
import { default as setToolbarApps } from './setToolbarApps'
import { default as skipVersion } from './skipVersion'
import { default as toggleTheme } from './toggleTheme'

export * from './types'

export default r({
	get,
	resolveModel,
	previewUpdate,
	setTheme,
	toggleTheme,
	setLanguage,
	setModel,
	setDevmode,
	setDevmodeAutoSave,
	skipVersion,
	clearSkippedVersions,
	setToolbarApps,
	setQuickSends,
	setSerialMonitor,
	buildSerialConnectOptions
})
