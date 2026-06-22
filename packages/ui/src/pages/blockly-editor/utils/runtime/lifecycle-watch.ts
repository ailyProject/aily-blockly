import type { Core } from '@/utils/core'
import type { BlocklyEditorSignals } from '../../types'

const BLOCKLY_EDITOR_LIFECYCLE_POLL_MS = 5000

const createLifecycleSignature = (lifecycle: Awaited<ReturnType<Core['project']['getLifecycleStatus']['query']>>) =>
	JSON.stringify({
		boardPackageName: lifecycle.boardPackageName || '',
		boardPackageVersion: lifecycle.boardPackageVersion || '',
		boardPackageReady: lifecycle.boardPackageReady ?? null,
		dependencySignature: lifecycle.dependencySignature,
		missingLibraryCount: lifecycle.missingLibraryCount,
		recoveredFromTemp: lifecycle.recoveredFromTemp,
		parseError: lifecycle.parseError || ''
	})

/**
 * 为 Blockly Editor 页面启动最小的项目生命周期轮询。
 * @param input - core 句柄、当前项目路径与页面 signals
 */
export const startBlocklyEditorLifecycleWatch = (input: {
	core: Core
	projectPath: string
	signals: BlocklyEditorSignals
}) => {
	let stopped = false
	let running = false
	let lastSignature = ''

	const poll = async () => {
		if (stopped || running || !input.projectPath.trim()) return
		running = true
		try {
			const lifecycle = await input.core.project.getLifecycleStatus.query({ projectPath: input.projectPath })
			const nextSignature = createLifecycleSignature(lifecycle)
			if (lastSignature && nextSignature !== lastSignature) {
				input.signals.projectReloadMessage.set(
					`Project dependencies or metadata changed outside the editor${lifecycle.recoveredFromTemp ? ' (temp snapshot recovered)' : ''}. Reload recommended.`
				)
			}
			lastSignature = nextSignature
		} catch {
			// ignore lifecycle polling failures; the editor still remains usable
		} finally {
			running = false
		}
	}

	void poll()
	const timer = setInterval(() => {
		void poll()
	}, BLOCKLY_EDITOR_LIFECYCLE_POLL_MS)

	return () => {
		stopped = true
		clearInterval(timer)
	}
}
