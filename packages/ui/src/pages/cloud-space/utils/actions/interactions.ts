import { createCloudSpaceEditorActions } from './editor'
import { createCloudSpaceLoadActions } from './load'
import { createCloudSpaceProjectActions } from './project'
import { createCloudSpaceSyncActions } from './sync'

import type { CloudSpaceActionContext } from '../../types'

/**
 * 创建 Cloud Space 的导入与项目动作。
 * @param input - 页面动作依赖
 */
export const createCloudSpacePageActions = (input: CloudSpaceActionContext) => {
	const loadActions = createCloudSpaceLoadActions(input)
	const projectActions = createCloudSpaceProjectActions(input)
	const editorActions = createCloudSpaceEditorActions(input)
	const syncActions = createCloudSpaceSyncActions(input)

	return {
		...loadActions,
		...projectActions,
		...editorActions,
		...syncActions,
		async importProjectWithSuggestedName() {
			await projectActions.importProjectWithSuggestedName(projectActions.importProject.bind(projectActions))
		},
		async saveEditedProject() {
			await editorActions.saveEditedProject(editorActions.cancelEditProject.bind(editorActions))
		}
	}
}
