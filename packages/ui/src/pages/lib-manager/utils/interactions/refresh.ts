import { config } from '@/workspace'

import { loadLibManagerPageState } from '../../runtime'

import type { Core } from '@/utils/core'
import type { LibManagerPageState } from '../../types'

/**
 * 刷新 lib-manager 页面状态与当前 npm registry。
 * @param input - 页面状态写入口与 Core 句柄
 */
export const refreshLibManagerPage = async (input: {
	core: Core
	setLoading: (loading: boolean) => void
	setError: (message: string | null) => void
	clearPendingInstallPrompt: () => void
	setState: (state: LibManagerPageState | null) => void
	setNpmRegistry: (registry: string) => void
}) => {
	input.setLoading(true)
	input.setError(null)
	input.clearPendingInstallPrompt()
	try {
		const [state, configSummary] = await Promise.all([
			loadLibManagerPageState(input.core),
			input.core.config.get.query({ config, fallbackLanguage: config.lang })
		])
		input.setState(state)
		input.setNpmRegistry(configSummary.npmRegistry || '')
	} catch (error) {
		input.setError(error instanceof Error ? error.message : String(error))
	} finally {
		input.setLoading(false)
	}
}
