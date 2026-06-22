import { applyThemeMode, getThemeMode, toggleThemeMode } from '@/runtime/theme'

import { loadHomePageCoreState } from '../runtime'
import { applyHomePageCoreState } from '../state'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { HomePageStateSignals } from '../state'

/**
 * 创建首页页面动作。
 * @param input - 首页动作依赖
 */
export const createHomePageActions = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	pageState: HomePageStateSignals
	themeMode: { set(value: string): void; (): string }
}) => ({
	async refreshDesktopBackendStatus() {
		if (!input.desktop) {
			input.pageState.desktopBackendManaged.set(false)
			input.pageState.desktopBackendReachable.set(false)
			return
		}

		try {
			const status = await input.desktop.core.getCoreStatus.query()
			input.pageState.desktopBackendManaged.set(status.managed)
			input.pageState.desktopBackendReachable.set(status.reachable)
			input.pageState.desktopBackendBaseUrl.set(status.address.baseUrl)
			input.pageState.desktopBackendError.set(null)
		} catch (error) {
			input.pageState.desktopBackendError.set((error as Error).message)
		}
	},
	async ensureDesktopBackendStarted() {
		if (!input.desktop) return

		try {
			const status = await input.desktop.core.ensureCoreStarted.query()
			input.pageState.desktopBackendManaged.set(status.managed)
			input.pageState.desktopBackendReachable.set(status.reachable)
			input.pageState.desktopBackendBaseUrl.set(status.address.baseUrl)
			input.pageState.desktopBackendError.set(null)
			await this.refreshCoreDerivedState()
		} catch (error) {
			input.pageState.desktopBackendError.set((error as Error).message)
		}
	},
	async refreshCoreDerivedState() {
		try {
			applyHomePageCoreState(input.pageState, await loadHomePageCoreState(input.core))
		} catch (error) {
			input.pageState.boardValidationText.set(`core route error: ${(error as Error).message}`)
			input.pageState.libraryValidationText.set('core route error')
		}
	},
	handleThemeToggle() {
		input.themeMode.set(toggleThemeMode())
	},
	useDarkMode() {
		input.themeMode.set(applyThemeMode('dark'))
	},
	getThemeActionLabel() {
		return input.themeMode() === 'dark' ? 'Switch to light' : 'Switch to dark'
	},
	getThemeMode() {
		return getThemeMode()
	}
})
