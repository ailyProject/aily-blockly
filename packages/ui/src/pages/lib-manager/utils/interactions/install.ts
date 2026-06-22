import { getCurrentProjectPath } from '@/runtime/project-session'

import { executeLibManagerRemove, executeLibManagerRestore } from '../actions/install'
import { resolveLibManagerInstallPrompt } from '../actions/prompt'

import type { LibManagerActionContext, LibManagerInstallPrompt, LibManagerPageState } from '../../types'

/**
 * 请求安装或恢复指定库。
 * @param input - 页面上下文与安装参数
 */
export const requestLibManagerRestore = async (input: {
	context: LibManagerActionContext
	state: LibManagerPageState | null
	setPendingInstallPrompt: (prompt: LibManagerInstallPrompt | null) => void
	packageName: string
	version?: string
	localPath?: string
}) => {
	const prompt = resolveLibManagerInstallPrompt(input.state, input.packageName, input.version, input.localPath)
	if (prompt) {
		input.setPendingInstallPrompt(prompt)
		return
	}

	await executeLibManagerRestore({
		context: input.context,
		packageName: input.packageName,
		version: input.version,
		localPath: input.localPath
	})
}

/**
 * 通过 desktop 选择本地 Blockly 库目录，并复用现有安装链导入。
 * @param input - 页面上下文与待确认提示写入口
 */
export const importLocalLibManagerLibrary = async (input: {
	context: LibManagerActionContext
	state: LibManagerPageState | null
	setPendingInstallPrompt: (prompt: LibManagerInstallPrompt | null) => void
}) => {
	if (!input.context.desktop) {
		input.context.statusMessage.set('Importing a local library currently requires the desktop host.')
		return
	}

	const projectPath = getCurrentProjectPath().trim()
	if (!projectPath) {
		input.context.statusMessage.set('Open a Blockly project before importing a local library.')
		return
	}

	input.context.statusMessage.set(null)
	const localPath = (await input.context.selectDesktopDirectory(input.context.desktop, projectPath)).trim()
	if (!localPath || localPath === projectPath) return

	const inspection = await input.context.core.project.inspectBlocklyLibrarySource.query({ localPath })
	if (!inspection.valid || !inspection.packageName) {
		input.context.statusMessage.set(inspection.error || 'Selected directory is not a supported Blockly library.')
		return
	}

	await requestLibManagerRestore({
		context: input.context,
		state: input.state,
		setPendingInstallPrompt: input.setPendingInstallPrompt,
		packageName: inspection.packageName,
		localPath: inspection.localPath
	})
}

/**
 * 执行指定库的移除动作。
 * @param input - 页面上下文与目标包名
 */
export const removeLibManagerLibrary = (input: { context: LibManagerActionContext; packageName: string }) =>
	executeLibManagerRemove({
		context: input.context,
		packageName: input.packageName
	})

/**
 * 执行兼容确认后的安装动作。
 * @param input - 页面上下文与当前待确认提示
 */
export const confirmLibManagerInstallPrompt = async (input: {
	context: LibManagerActionContext
	prompt: LibManagerInstallPrompt | null
	setPendingInstallPrompt: (prompt: LibManagerInstallPrompt | null) => void
}) => {
	if (!input.prompt) return
	input.setPendingInstallPrompt(null)
	await executeLibManagerRestore({
		context: input.context,
		packageName: input.prompt.packageName,
		version: input.prompt.version,
		localPath: input.prompt.localPath
	})
}
