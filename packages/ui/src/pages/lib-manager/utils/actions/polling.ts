import type { LibManagerActionContext } from '../../types'

/**
 * 轮询当前库动作的实时状态。
 * @param input - core 依赖、目标项目与状态 signal
 */
export const startLibManagerActionPolling = (input: {
	core: LibManagerActionContext['core']
	projectPath: string
	packageName: string
	action: 'install' | 'remove'
	liveActionStatus: LibManagerActionContext['liveActionStatus']
}) => {
	let stopped = false
	const poll = async () => {
		if (stopped) return
		try {
			const status = await input.core.project.getBlocklyLibraryActionStatus.query({
				projectPath: input.projectPath,
				packageName: input.packageName,
				action: input.action
			})
			if (!status) return
			input.liveActionStatus.set({
				action: status.action,
				packageName: status.packageName,
				running: status.running,
				stdout: status.stdout,
				stderr: status.stderr,
				progressEvents: status.progressEvents,
				updatedAt: status.updatedAt
			})
		} catch {
			return
		}
	}

	void poll()
	const timer = setInterval(() => {
		void poll()
	}, 500)

	return () => {
		stopped = true
		clearInterval(timer)
	}
}
