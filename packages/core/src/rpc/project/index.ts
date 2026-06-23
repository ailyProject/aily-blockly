import { r } from '../trpc'
import { default as acquireOpenSessionLock } from './acquireOpenSessionLock'
import { default as addRecentModelProject } from './addRecentModelProject'
import { default as addRecentProject } from './addRecentProject'
import { default as addStoredRecentProject } from './addStoredRecentProject'
import { default as closePage } from './closePage'
import { default as compareActiveWorkspace } from './compareActiveWorkspace'
import { default as createPage } from './createPage'
import { default as createProject } from './createProject'
import { default as findAvailableName } from './findAvailableName'
import { default as getBlocklyLibraryActionStatus } from './getBlocklyLibraryActionStatus'
import { default as getBlocklyLibraryStatus } from './getBlocklyLibraryStatus'
import { default as getCloudBinding } from './getCloudBinding'
import { default as getDefaultProjectRootPath } from './getDefaultProjectRootPath'
import { default as getLifecycleStatus } from './getLifecycleStatus'
import { default as getRecentModelProjects } from './getRecentModelProjects'
import { default as getRecentProjects } from './getRecentProjects'
import { default as getStoredRecentProjects } from './getStoredRecentProjects'
import { default as importCloudProject } from './importCloudProject'
import { default as inspectBlocklyLibrarySource } from './inspectBlocklyLibrarySource'
import { default as installBlocklyLibrary } from './installBlocklyLibrary'
import { default as listBlocklyLibraryVersions } from './listBlocklyLibraryVersions'
import { default as openPage } from './openPage'
import { default as pathExists } from './pathExists'
import { default as readAbiSummary } from './readAbiSummary'
import { default as readActiveWorkspace } from './readActiveWorkspace'
import { default as readDocument } from './readDocument'
import { default as readSource } from './readSource'
import { default as releaseOpenSessionLock } from './releaseOpenSessionLock'
import { default as removeBlocklyLibrary } from './removeBlocklyLibrary'
import { default as removeRecentModelProject } from './removeRecentModelProject'
import { default as removeRecentProject } from './removeRecentProject'
import { default as removeStoredRecentProject } from './removeStoredRecentProject'
import { default as renamePage } from './renamePage'
import { default as resolveEditorRoute } from './resolveEditorRoute'
import { default as resolveOpenPath } from './resolveOpenPath'
import { default as resolveProjectPath } from './resolveProjectPath'
import { default as resolveProjectRootPath } from './resolveProjectRootPath'
import { default as searchBlocklyLibraryRegistry } from './searchBlocklyLibraryRegistry'
import { default as switchPage } from './switchPage'
import { default as syncCloudProject } from './syncCloudProject'
import { default as updateActiveViewState } from './updateActiveViewState'
import { default as updateActiveWorkspace } from './updateActiveWorkspace'
import { default as validateName } from './validateName'

export default r({
	getRecentProjects,
	getStoredRecentProjects,
	acquireOpenSessionLock,
	compareActiveWorkspace,
	getBlocklyLibraryActionStatus,
	getBlocklyLibraryStatus,
	getCloudBinding,
	getLifecycleStatus,
	readDocument,
	readActiveWorkspace,
	createProject,
	findAvailableName,
	importCloudProject,
	inspectBlocklyLibrarySource,
	installBlocklyLibrary,
	listBlocklyLibraryVersions,
	searchBlocklyLibraryRegistry,
	createPage,
	switchPage,
	openPage,
	closePage,
	renamePage,
	readAbiSummary,
	addRecentProject,
	addStoredRecentProject,
	removeStoredRecentProject,
	removeRecentProject,
	getRecentModelProjects,
	addRecentModelProject,
	removeRecentModelProject,
	resolveProjectPath,
	pathExists,
	readSource,
	releaseOpenSessionLock,
	removeBlocklyLibrary,
	resolveEditorRoute,
	resolveOpenPath,
	resolveProjectRootPath,
	getDefaultProjectRootPath,
	syncCloudProject,
	updateActiveWorkspace,
	updateActiveViewState,
	validateName
})
