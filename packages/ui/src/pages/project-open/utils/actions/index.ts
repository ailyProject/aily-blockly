import { createProjectOpenOpenActions } from './open'
import { createProjectOpenPreviewActions } from './preview'

import type { ProjectOpenActionContext, ProjectOpenActionState } from '../types'

/**
 * 创建 Project Open 页面动作。
 * @param input - 页面依赖与状态
 */
export const createProjectOpenActions = (input: ProjectOpenActionContext) => ({
	...createProjectOpenPreviewActions(input),
	...createProjectOpenOpenActions(input)
})

export type { ProjectOpenActionContext, ProjectOpenActionState }
