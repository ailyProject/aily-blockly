import { createGraphEditorDraftActions } from './edit/drafts'
import { createGraphEditorPersistenceActions } from './edit/persistence'
import { createGraphEditorSyncActions } from './edit/sync'

import type { Core } from '@/utils/core'
import type { GraphEditorSignals } from '../types'

export * from './edit/drafts'
export * from './edit/persistence'
export * from './edit/sync'

/**
 * 组合 Graph Editor 的全部编辑类动作。
 * @param input - 页面信号、外部依赖与刷新入口
 */
export const createGraphEditorEditActions = (input: {
	core: Core
	signals: GraphEditorSignals
	refreshLibraryInfo: () => Promise<void>
	reload: () => Promise<void>
}) => ({
	...createGraphEditorDraftActions(input),
	...createGraphEditorPersistenceActions(input),
	...createGraphEditorSyncActions(input)
})
