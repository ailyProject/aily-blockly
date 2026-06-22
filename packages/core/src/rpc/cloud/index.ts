import { r } from '../trpc'
import { default as deleteProject } from './deleteProject'
import { default as listProjects } from './listProjects'
import { default as listPublicProjects } from './listPublicProjects'
import { default as listTemplates } from './listTemplates'
import { default as publishProject } from './publishProject'
import { default as setProjectTemplate } from './setProjectTemplate'
import { default as unpublishProject } from './unpublishProject'
import { default as unsetProjectTemplate } from './unsetProjectTemplate'
import { default as updateProject } from './updateProject'

export default r({
	deleteProject,
	listProjects,
	listPublicProjects,
	listTemplates,
	publishProject,
	setProjectTemplate,
	unpublishProject,
	unsetProjectTemplate,
	updateProject
})
