import { subscribeProjectMutationEvent } from '@/runtime/project-events'

import {
	initializeCodeEditorDesktopRuntime,
	initializeCodeEditorPage,
	refreshCodeEditorPlan,
	startCodeEditorBleDiscovery
} from './component.runtime'
import { startCodeEditorLifecycleWatch } from './lifecycle.watch'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { Unsubscribable } from '@trpc/server/observable'
import type { CodeEditorSignals } from './component.types'

/**
 * 执行 Code Editor 页面初始化序列。
 * @param input - 初始化所需依赖
 */
export const initializeCodeEditorLifecycle = async (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	initialProjectPath: string | null
	loadDesktopHostRuntimeInfo: (desktop: NonNullable<Desktop>) => Promise<DesktopHostRuntimeInfo>
	signals: CodeEditorSignals
}): Promise<Unsubscribable | null> => {
	await initializeCodeEditorPage({
		core: input.core,
		desktop: input.desktop,
		initialProjectPath: input.initialProjectPath,
		signals: input.signals
	})
	const bleSubscription = startCodeEditorBleDiscovery({
		desktop: input.desktop,
		signals: input.signals
	})
	await initializeCodeEditorDesktopRuntime({
		desktop: input.desktop,
		loadDesktopHostRuntimeInfo: input.loadDesktopHostRuntimeInfo,
		signals: input.signals
	})
	await refreshCodeEditorPlan({
		core: input.core,
		signals: input.signals
	})

	const stopLifecycleWatch = startCodeEditorLifecycleWatch({
		core: input.core,
		signals: input.signals
	})
	const stopProjectMutationWatch = subscribeProjectMutationEvent(async detail => {
		if (detail.type === 'session-change') return
		if (detail.projectPath !== input.signals.projectPath().trim()) return

		if (input.signals.buildBusy() || input.signals.uploadBusy()) {
			input.signals.projectReloadMessage.set(
				`${detail.type === 'cloud-sync' ? 'Project cloud binding' : `Library ${detail.packageName}`} changed while ${input.signals.buildBusy() ? 'build' : 'upload'} is running. Refresh project state when the current action finishes.`
			)
			return
		}

		input.signals.projectReloadBusy.set(true)
		input.signals.projectReloadMessage.set(null)
		try {
			await initializeCodeEditorPage({
				core: input.core,
				desktop: input.desktop,
				initialProjectPath: input.signals.projectPath().trim(),
				signals: input.signals
			})
			await refreshCodeEditorPlan({
				core: input.core,
				signals: input.signals
			})
			input.signals.projectReloadMessage.set(
				detail.type === 'cloud-sync'
					? `Project cloud binding changed. Build and upload plans refreshed.`
					: `Library ${detail.packageName} changed. Build and upload plans refreshed.`
			)
		} catch (error) {
			input.signals.projectReloadMessage.set(error instanceof Error ? error.message : String(error))
		} finally {
			input.signals.projectReloadBusy.set(false)
		}
	})

	return {
		unsubscribe() {
			bleSubscription?.unsubscribe()
			stopLifecycleWatch()
			stopProjectMutationWatch()
		}
	}
}

/**
 * 清理 Code Editor 生命周期资源。
 * @param lifecycleResource - 生命周期清理句柄
 */
export const disposeCodeEditorLifecycle = (lifecycleResource: Unsubscribable | null) => {
	lifecycleResource?.unsubscribe()
}
