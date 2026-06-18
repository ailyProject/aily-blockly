import { r } from '../trpc'
import { buildSerialConnectOptions } from './buildSerialConnectOptions'
import { clearSkippedVersions } from './clearSkippedVersions'
import { get } from './get'
import { resolveModel } from './model'
import { previewUpdate } from './previewUpdate'
import { setDevmode } from './setDevmode'
import { setDevmodeAutoSave } from './setDevmodeAutoSave'
import { setLanguage } from './setLanguage'
import { setModel } from './setModel'
import { setQuickSends } from './setQuickSends'
import { setSerialMonitor } from './setSerialMonitor'
import { setTheme } from './setTheme'
import { setToolbarApps } from './setToolbarApps'
import { skipVersion } from './skipVersion'
import { toggleTheme } from './toggleTheme'

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
