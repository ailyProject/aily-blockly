import { createCloudSpaceEditorActions } from './page-actions.runtime.editor'
import { createCloudSpaceLoadActions } from './page-actions.runtime.load'
import { createCloudSpaceProjectActions } from './page-actions.runtime.project'
import { createCloudSpaceSyncActions } from './page-actions.runtime.sync'

import type { CloudSpaceActionContext } from './page-actions.types'

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
