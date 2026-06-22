import { dispatchProjectLibraryMutationEvent } from '@/runtime/project-events'
import { getCurrentProjectPath } from '@/runtime/project-session'

import { startLibManagerActionPolling } from './polling'

import type { LibManagerActionContext } from '../../types'

/**
 * 执行库安装/恢复动作。
 * @param input - 动作依赖、目标包与可选版本/路径
 */
export const executeLibManagerRestore = async (input: {
	context: LibManagerActionContext
	packageName: string
	version?: string
	localPath?: string
}) => {
	const projectPath = getCurrentProjectPath()
	if (!projectPath) return
	input.context.actionBusyKey.set(`install:${input.packageName}`)
	input.context.statusMessage.set(null)
	input.context.lastActionOutput.set(null)
	input.context.liveActionStatus.set(null)
	const stopPolling = startLibManagerActionPolling({
		core: input.context.core,
		projectPath,
		packageName: input.packageName,
		action: 'install',
		liveActionStatus: input.context.liveActionStatus
	})
	try {
		const result = await input.context.core.project.installBlocklyLibrary.mutate({
			projectPath,
			packageName: input.packageName,
			version: input.version?.trim() ? input.version : undefined,
			localPath: input.localPath?.trim() ? input.localPath : undefined
		})
		input.context.statusMessage.set(result.message)
		input.context.lastActionOutput.set({
			action: 'install',
			packageName: input.packageName,
			success: result.success,
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
			progressEvents: result.progressEvents
		})
		if (result.success) {
			dispatchProjectLibraryMutationEvent({
				projectPath,
				action: 'install',
				packageName: input.packageName,
				occurredAt: new Date().toISOString()
			})
		}
		await input.context.refresh()
	} catch (error) {
		input.context.statusMessage.set(error instanceof Error ? error.message : String(error))
	} finally {
		stopPolling()
		input.context.actionBusyKey.set(null)
	}
}

/**
 * 执行库移除动作。
 * @param input - 动作依赖与目标包名
 */
export const executeLibManagerRemove = async (input: { context: LibManagerActionContext; packageName: string }) => {
	const projectPath = getCurrentProjectPath()
	if (!projectPath) return
	input.context.actionBusyKey.set(`remove:${input.packageName}`)
	input.context.statusMessage.set(null)
	input.context.lastActionOutput.set(null)
	input.context.liveActionStatus.set(null)
	const stopPolling = startLibManagerActionPolling({
		core: input.context.core,
		projectPath,
		packageName: input.packageName,
		action: 'remove',
		liveActionStatus: input.context.liveActionStatus
	})
	try {
		const result = await input.context.core.project.removeBlocklyLibrary.mutate({
			projectPath,
			packageName: input.packageName
		})
		input.context.statusMessage.set(result.message)
		input.context.lastActionOutput.set({
			action: 'remove',
			packageName: input.packageName,
			success: result.success,
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
			progressEvents: result.progressEvents
		})
		if (result.success) {
			dispatchProjectLibraryMutationEvent({
				projectPath,
				action: 'remove',
				packageName: input.packageName,
				occurredAt: new Date().toISOString()
			})
		}
		await input.context.refresh()
	} catch (error) {
		input.context.statusMessage.set(error instanceof Error ? error.message : String(error))
	} finally {
		stopPolling()
		input.context.actionBusyKey.set(null)
	}
}
