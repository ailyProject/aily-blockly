import { loadCodeEditorUploadPlan, runCodeEditorUpload } from '../upload'
import { loadCodeEditorBuildPlan, runCodeEditorBuild } from './runtime'

import type { Core } from '@/utils/core'
import type { CodeEditorSignals } from '../../types'

/**
 * 刷新上传计划。
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
 * 刷新构建计划。
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
 * 执行构建动作。
 */
export const runCodeEditorBuildAction = async (input: { core: Core; signals: CodeEditorSignals }) => {
	const runtimeInfo = input.signals.runtimeInfo()
	const projectPath = input.signals.projectPath().trim()
	if (!runtimeInfo || !projectPath) return

	input.signals.buildBusy.set(true)
	input.signals.buildError.set(null)
	try {
		input.signals.buildResult.set(
			await runCodeEditorBuild(input.core, runtimeInfo, projectPath, input.signals.sourceCode())
		)
		await refreshCodeEditorPlan(input)
	} catch (error) {
		input.signals.buildResult.set(null)
		input.signals.buildError.set(error instanceof Error ? error.message : String(error))
	} finally {
		input.signals.buildBusy.set(false)
	}
}

/**
 * 执行串口上传动作。
 */
export const runCodeEditorUploadAction = async (input: { core: Core; signals: CodeEditorSignals }) => {
	const runtimeInfo = input.signals.runtimeInfo()
	const projectPath = input.signals.projectPath().trim()
	const serialPort = input.signals.serialPort().trim()
	if (!runtimeInfo || !projectPath || !serialPort) return

	input.signals.uploadBusy.set(true)
	input.signals.buildError.set(null)
	try {
		input.signals.uploadResult.set(
			await runCodeEditorUpload(input.core, runtimeInfo, projectPath, input.signals.sourceCode(), serialPort)
		)
		await refreshCodeEditorPlan(input)
	} catch (error) {
		input.signals.uploadResult.set(null)
		input.signals.buildError.set(error instanceof Error ? error.message : String(error))
	} finally {
		input.signals.uploadBusy.set(false)
	}
}
