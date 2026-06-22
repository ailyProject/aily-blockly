import type { ProjectBlocklyLibraryActionStatus, ProjectBlocklyLibraryMutationResult } from '../types'

const currentProjectLibraryActions = new Map<string, ProjectBlocklyLibraryActionStatus>()

const toActionStatusKey = (input: { projectPath: string; packageName: string; action: 'install' | 'remove' }) =>
	`${input.projectPath}::${input.packageName}::${input.action}`

/**
 * 开始记录当前项目库动作状态。
 * @param input - 初始动作状态
 */
export const beginProjectBlocklyLibraryActionStatus = (input: {
	projectPath: string
	packageName: string
	action: 'install' | 'remove'
}) => {
	const key = toActionStatusKey(input)
	currentProjectLibraryActions.set(key, {
		...input,
		running: true,
		stdout: '',
		stderr: '',
		progressEvents: [],
		updatedAt: new Date().toISOString()
	})
}

/**
 * 更新当前项目库动作状态。
 * @param input - 当前最新动作状态
 */
export const updateProjectBlocklyLibraryActionStatus = (input: {
	projectPath: string
	packageName: string
	action: 'install' | 'remove'
	stdout: string
	stderr: string
	progressEvents: ProjectBlocklyLibraryActionStatus['progressEvents']
}) => {
	const key = toActionStatusKey(input)
	const current = currentProjectLibraryActions.get(key)
	if (!current) return

	currentProjectLibraryActions.set(key, {
		...current,
		stdout: input.stdout,
		stderr: input.stderr,
		progressEvents: input.progressEvents,
		updatedAt: new Date().toISOString()
	})
}

/**
 * 结束当前项目库动作状态。
 * @param result - 最终动作结果
 */
export const finishProjectBlocklyLibraryActionStatus = (result: ProjectBlocklyLibraryMutationResult) => {
	const key = toActionStatusKey(result)
	currentProjectLibraryActions.set(key, {
		action: result.action,
		projectPath: result.projectPath,
		packageName: result.packageName,
		running: false,
		stdout: result.stdout,
		stderr: result.stderr,
		progressEvents: result.progressEvents,
		updatedAt: new Date().toISOString()
	})
}

/**
 * 读取当前项目库动作状态。
 * @param input - 项目路径、库包名与动作类型
 */
export const getProjectBlocklyLibraryActionStatus = (input: {
	projectPath: string
	packageName: string
	action: 'install' | 'remove'
}) => currentProjectLibraryActions.get(toActionStatusKey(input)) ?? null
