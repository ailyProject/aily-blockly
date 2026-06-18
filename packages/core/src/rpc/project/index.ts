import { r } from '../trpc'
import {
	addRecentlyProject,
	getDefaultProjectRootPath,
	isSameProjectPath,
	removeRecentlyProject,
	resolveProjectPath,
	resolveProjectRootPath
} from './paths'
import {
	addRecentModelProject,
	getRecentModelProjects,
	removeRecentModelProject,
	setRecentModelProjects
} from './recentModelProjects'
import { addRecentProject, getRecentProjects, removeRecentProject, setRecentProjects } from './recentProjects'
import { resolveRegions } from './regions'

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
