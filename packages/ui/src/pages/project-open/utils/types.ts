import type { Core } from '@/utils/core'
import type { Desktop, SelectDesktopProjectPath } from '@/utils/desktop'
import type { WritableSignal } from '@angular/core'
import type { Router } from '@angular/router'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { RecentlyProjectEntry } from 'shared'
import type { loadProjectOpenLifecycle } from '../runtime'

/**
 * Project Open 页面锁冲突信息。
 */
export interface ProjectOpenSessionConflict {
	/**
	 * 发生冲突的项目根目录路径。
	 */
	projectPath: string

	/**
	 * 当前锁持有者标识；未知时为 `null`。
	 */
	owner: string | null

	/**
	 * 当前锁持有者进程 ID；未知时为 `null`。
	 */
	pid: number | null
}

/**
 * Project Open 页面状态句柄集合。
 */
export interface ProjectOpenActionState {
	runtimeInfo: WritableSignal<DesktopHostRuntimeInfo | null>
	recentProjects: WritableSignal<Array<RecentlyProjectEntry>>
	selectedPath: WritableSignal<string>
	resolvedProjectPath: WritableSignal<string>
	previewLifecycle: WritableSignal<Awaited<ReturnType<typeof loadProjectOpenLifecycle>> | null>
	statusMessage: WritableSignal<string | null>
	openBusy: WritableSignal<boolean>
	openSessionConflict: WritableSignal<ProjectOpenSessionConflict | null>
}

/**
 * Project Open 页面动作依赖。
 */
export interface ProjectOpenActionContext {
	core: Core
	desktop: NonNullable<Desktop> | null
	router: Router
	state: ProjectOpenActionState
	selectDesktopProjectPath: SelectDesktopProjectPath
}
