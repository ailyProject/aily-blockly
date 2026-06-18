import { r } from '../trpc'
import { addRecentModelProject } from './addRecentModelProject'
import { addRecentProject } from './addRecentProject'
import { buildSerialConnectOptions } from './buildSerialConnectOptions'
import { clearSkippedVersions } from './clearSkippedVersions'
import { completeOnboarding } from './completeOnboarding'
import { get } from './get'
import { getOnboarding } from './getOnboarding'
import { getRecentModelProjects } from './getRecentModelProjects'
import { getRecentProjects } from './getRecentProjects'
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
import { resolveModel } from './model'
import { previewUpdate } from './previewUpdate'
import { removeRecentModelProject } from './removeRecentModelProject'
import { removeRecentProject } from './removeRecentProject'
import { setDevmode } from './setDevmode'
import { setDevmodeAutoSave } from './setDevmodeAutoSave'
import { setLanguage } from './setLanguage'
import { setModel } from './setModel'
import { setQuickSends } from './setQuickSends'
import { setRecentModelProjects } from './setRecentModelProjects'
import { setRecentProjects } from './setRecentProjects'
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
	buildSerialConnectOptions,
	getRecentProjects,
	setRecentProjects,
	addRecentProject,
	removeRecentProject,
	getRecentModelProjects,
	setRecentModelProjects,
	addRecentModelProject,
	removeRecentModelProject,
	getOnboarding,
	completeOnboarding,
	resolveLayout,
	createDefaultLayout,
	mergeVisibleOrder,
	setLayout,
	addApp,
	removeApp,
	toggleApp,
	reset
})
