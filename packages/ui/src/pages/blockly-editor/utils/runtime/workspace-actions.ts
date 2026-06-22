import { parseBlocklyWorkspaceDraft } from '../workspace-editor'
import { refreshBlocklyEditorPage } from './apply'

import type { Core } from '@/utils/core'
import type { BlocklyEditorSignals } from '../../types'

/**
 * 更新工作区 JSON 草稿，并同步本地预览状态。
 * @param raw - 当前草稿文本
 * @param signals - 页面信号集合
 */
export const updateBlocklyEditorWorkspaceDraft = (raw: string, signals: BlocklyEditorSignals) => {
	signals.activeWorkspaceJson.set(raw)
	signals.activeWorkspaceDirty.set(true)
	signals.activeWorkspaceSaveMessage.set(null)
	const draft = parseBlocklyWorkspaceDraft(raw)
	signals.activeWorkspaceParseError.set(draft.error ?? null)
	if (draft.valid) {
		signals.activeTopLevelBlockCount.set(draft.topLevelBlockCount)
		signals.activeTopLevelBlockTypes.set(draft.topLevelBlockTypes)
		return
	}

	signals.activeTopLevelBlockCount.set(0)
	signals.activeTopLevelBlockTypes.set([])
}

/**
 * 保存 active workspace JSON 草稿。
 * @param core - core 句柄
 * @param projectPath - 当前项目路径
 * @param signals - 页面信号集合
 */
export const saveBlocklyEditorWorkspaceDraft = async (
	core: Core,
	projectPath: string,
	signals: BlocklyEditorSignals
) => {
	const draft = parseBlocklyWorkspaceDraft(signals.activeWorkspaceJson())
	if (!draft.valid) {
		signals.activeWorkspaceParseError.set(draft.error ?? 'Invalid workspace JSON')
		return
	}

	signals.activeWorkspaceSaveBusy.set(true)
	try {
		await core.project.updateActiveWorkspace.mutate({
			projectPath,
			payload: draft.payload
		})
		const projectSession = await import('@/runtime/project-session')
		projectSession.setCurrentProjectSourceCode('')
		await refreshBlocklyEditorPage(core, projectPath, signals)
		signals.activeWorkspaceSaveMessage.set('Workspace saved to project.abi')
	} catch (error) {
		signals.activeWorkspaceSaveMessage.set(error instanceof Error ? error.message : String(error))
	} finally {
		signals.activeWorkspaceSaveBusy.set(false)
	}
}
