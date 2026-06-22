import { createProjectOpenOpenActions } from './component.actions.open'
import { createProjectOpenPreviewActions } from './component.actions.preview'

import type { ProjectOpenActionContext, ProjectOpenActionState } from './component.actions.types'

/**
 * 创建 Project Open 页面动作。
 * @param input - 页面依赖与状态
 */
export const createProjectOpenActions = (input: ProjectOpenActionContext) => ({
	...createProjectOpenPreviewActions(input),
	...createProjectOpenOpenActions(input)
})

export type { ProjectOpenActionContext, ProjectOpenActionState }
