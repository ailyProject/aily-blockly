import { refreshBlocklyEditorPage } from './apply'

import type { Core } from '@/utils/core'
import type { BlocklyEditorSignals } from '../../types'

/**
 * 更新 active page viewState 草稿。
 * @param field - 目标字段
 * @param value - 草稿值
 * @param signals - 页面信号集合
 */
export const updateBlocklyEditorViewStateDraft = (
	field: 'scale' | 'scrollX' | 'scrollY',
	value: string,
	signals: BlocklyEditorSignals
) => {
	if (field === 'scale') {
		signals.activeViewScaleDraft.set(value)
		return
	}
	if (field === 'scrollX') {
		signals.activeViewScrollXDraft.set(value)
		return
	}
	signals.activeViewScrollYDraft.set(value)
}

/**
 * 保存 active page viewState 草稿。
 * @param core - core 句柄
 * @param projectPath - 当前项目路径
 * @param signals - 页面信号集合
 */
export const saveBlocklyEditorViewStateDraft = async (
	core: Core,
	projectPath: string,
	signals: BlocklyEditorSignals
) => {
	await core.project.updateActiveViewState.mutate({
		projectPath,
		viewState: {
			scale: Number(signals.activeViewScaleDraft()),
			scrollX: Number(signals.activeViewScrollXDraft()),
			scrollY: Number(signals.activeViewScrollYDraft())
		}
	})
	await refreshBlocklyEditorPage(core, projectPath, signals)
}
