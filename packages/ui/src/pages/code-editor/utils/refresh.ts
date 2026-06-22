import { loadCodeEditorBuildPlan } from './build/runtime'
import { loadCodeEditorUploadPlan } from './upload'

import type { Core } from '@/utils/core'
import type { CodeEditorSignals } from '../types'

/**
 * 基于当前 signal 状态刷新上传计划预览。
 * @param input - core 句柄与页面 signals
 */
export const refreshCodeEditorUploadPlan = async (input: { core: Core; signals: CodeEditorSignals }) => {
	const runtimeInfo = input.signals.runtimeInfo()
	const projectPath = input.signals.projectPath().trim()
	const serialPort = input.signals.serialPort().trim()
	if (!runtimeInfo || !projectPath || !serialPort) {
		input.signals.uploadPlan.set(null)
		return
	}

	try {
		input.signals.uploadPlan.set(await loadCodeEditorUploadPlan(input.core, runtimeInfo, projectPath, serialPort))
	} catch {
		input.signals.uploadPlan.set(null)
	}
}

/**
 * 基于当前 signal 状态刷新构建与上传计划。
 * @param input - core 句柄与页面 signals
 */
export const refreshCodeEditorPlan = async (input: { core: Core; signals: CodeEditorSignals }) => {
	const runtimeInfo = input.signals.runtimeInfo()
	const projectPath = input.signals.projectPath().trim()
	if (!runtimeInfo || !projectPath) {
		input.signals.buildPlan.set(null)
		return
	}

	input.signals.buildError.set(null)
	try {
		input.signals.buildPlan.set(
			await loadCodeEditorBuildPlan(input.core, runtimeInfo, projectPath, input.signals.sourceCode())
		)
		await refreshCodeEditorUploadPlan(input)
	} catch (error) {
		input.signals.buildPlan.set(null)
		input.signals.buildError.set(error instanceof Error ? error.message : String(error))
	}
}

/**
 * 标记当前页面存在待处理的外部变更刷新。
 * @param signals - 页面信号集合
 * @param reason - 需要在当前动作结束后补刷新的原因
 * @param action - 当前占用中的动作名称
 */
export const markPendingCodeEditorExternalRefresh = (
	signals: CodeEditorSignals,
	reason: string,
	action: 'build' | 'upload'
) => {
	signals.pendingExternalRefreshReason.set(reason)
	signals.projectReloadMessage.set(
		`${reason} changed while ${action} is running. Plans will refresh automatically when the current action finishes.`
	)
}

/**
 * 在构建/上传完成后消费待处理的外部刷新请求。
 * @param input - core 句柄与页面 signals
 */
export const flushPendingCodeEditorExternalRefresh = async (input: { core: Core; signals: CodeEditorSignals }) => {
	const reason = input.signals.pendingExternalRefreshReason()
	if (!reason) return

	input.signals.pendingExternalRefreshReason.set(null)
	input.signals.projectReloadBusy.set(true)
	try {
		await refreshCodeEditorPlan(input)
		input.signals.projectReloadMessage.set(
			`${reason} changed during the previous action. Build and upload plans were refreshed automatically.`
		)
	} catch (error) {
		input.signals.projectReloadMessage.set(error instanceof Error ? error.message : String(error))
	} finally {
		input.signals.projectReloadBusy.set(false)
	}
}
