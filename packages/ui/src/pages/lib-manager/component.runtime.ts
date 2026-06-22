import type { Core } from '@/utils/core'
import type { Desktop, SelectDesktopDirectory } from '@/utils/desktop'
import type { WritableSignal } from '@angular/core'
import type {
	LibManagerActionContext,
	LibManagerActionOutput,
	LibManagerInstallPrompt,
	LibManagerLibraryScope,
	LibManagerLiveActionStatus,
	LibManagerPageState,
	LibManagerRegistryLibraryView,
	LibManagerVersionState
} from './types'

/**
 * 组装 lib-manager 页面动作上下文。
 * @param input - 页面 signals、Core 句柄与刷新函数
 */
export const createLibManagerActionContext = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	selectDesktopDirectory: SelectDesktopDirectory
	state: () => LibManagerPageState | null
	actionBusyKey: WritableSignal<string | null>
	statusMessage: WritableSignal<string | null>
	lastActionOutput: WritableSignal<LibManagerActionOutput | null>
	liveActionStatus: WritableSignal<LibManagerLiveActionStatus | null>
	pendingInstallPrompt: WritableSignal<LibManagerInstallPrompt | null>
	registrySearchBusy: WritableSignal<boolean>
	registrySearchResults: WritableSignal<Array<LibManagerRegistryLibraryView>>
	versionLoadingPackage: WritableSignal<string | null>
	libraryVersionsByPackage: WritableSignal<Record<string, LibManagerVersionState>>
	npmRegistry: WritableSignal<string>
	refresh: () => Promise<void>
}): LibManagerActionContext => ({
	core: input.core,
	desktop: input.desktop,
	selectDesktopDirectory: input.selectDesktopDirectory,
	state: input.state,
	actionBusyKey: input.actionBusyKey,
	statusMessage: input.statusMessage,
	lastActionOutput: input.lastActionOutput,
	liveActionStatus: input.liveActionStatus,
	pendingInstallPrompt: input.pendingInstallPrompt,
	registrySearchBusy: input.registrySearchBusy,
	registrySearchResults: input.registrySearchResults,
	versionLoadingPackage: input.versionLoadingPackage,
	libraryVersionsByPackage: input.libraryVersionsByPackage,
	npmRegistry: input.npmRegistry,
	refresh: input.refresh
})

/**
 * 判断当前是否选中了指定 scope。
 * @param currentScope - 当前页面 scope
 * @param scope - 目标 scope
 */
export const isLibManagerScopeSelected = (currentScope: LibManagerLibraryScope, scope: LibManagerLibraryScope) =>
	currentScope === scope

/**
 * 判断是否应显示已声明库分区。
 * @param scope - 当前页面 scope
 */
export const shouldShowLibManagerDeclaredSection = (scope: LibManagerLibraryScope) =>
	scope === 'all' || scope === 'installed'

/**
 * 判断是否应显示缺失库分区。
 * @param scope - 当前页面 scope
 */
export const shouldShowLibManagerMissingSection = (scope: LibManagerLibraryScope) =>
	scope === 'all' || scope === 'missing'

/**
 * 判断是否应显示 catalog 分区。
 * @param scope - 当前页面 scope
 */
export const shouldShowLibManagerCatalogSection = (scope: LibManagerLibraryScope) =>
	scope === 'all' || scope === 'catalog'

/**
 * 估算当前实时动作的进度百分比。
 * @param status - 当前实时动作状态
 */
export const resolveLibManagerLiveActionProgressPercent = (status: LibManagerLiveActionStatus | null) => {
	const event = status?.progressEvents.at(-1)
	if (!event) return undefined
	if (event.phase === 'done') return 100
	if (typeof event.added === 'number' && typeof event.resolved === 'number' && event.resolved > 0) {
		return Math.max(0, Math.min(100, Math.round((event.added / event.resolved) * 100)))
	}
	if (typeof event.downloaded === 'number' && typeof event.resolved === 'number' && event.resolved > 0) {
		return Math.max(0, Math.min(100, Math.round((event.downloaded / event.resolved) * 100)))
	}
	return undefined
}

/**
 * 读取当前实时动作的最近一条结构化日志。
 * @param status - 当前实时动作状态
 */
export const resolveLibManagerLiveActionLatestLine = (status: LibManagerLiveActionStatus | null) =>
	status?.progressEvents.at(-1)?.line || ''
