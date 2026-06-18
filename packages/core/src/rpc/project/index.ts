import { r } from '../trpc'
import { default as addRecentlyProject } from './addRecentlyProject'
import { default as addRecentModelProject } from './addRecentModelProject'
import { default as addRecentProject } from './addRecentProject'
import { default as getDefaultProjectRootPath } from './getDefaultProjectRootPath'
import { default as getRecentModelProjects } from './getRecentModelProjects'
import { default as getRecentProjects } from './getRecentProjects'
import { default as isSameProjectPath } from './isSameProjectPath'
import { default as resolveRegions } from './regions'
import { default as removeRecentlyProject } from './removeRecentlyProject'
import { default as removeRecentModelProject } from './removeRecentModelProject'
import { default as removeRecentProject } from './removeRecentProject'
import { default as resolveProjectPath } from './resolveProjectPath'
import { default as resolveProjectRootPath } from './resolveProjectRootPath'
import { default as setRecentModelProjects } from './setRecentModelProjects'
import { default as setRecentProjects } from './setRecentProjects'

export default r({
	getRecentProjects,
	setRecentProjects,
	addRecentProject,
	removeRecentProject,
	getRecentModelProjects,
	setRecentModelProjects,
	addRecentModelProject,
	removeRecentModelProject,
	addRecentlyProject,
	removeRecentlyProject,
	resolveProjectPath,
	resolveProjectRootPath,
	getDefaultProjectRootPath,
	isSameProjectPath,
	resolveRegions
})
