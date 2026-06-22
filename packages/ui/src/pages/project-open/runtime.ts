import { openProjectInEditor } from '@/runtime/project-routing'

import type { Core } from '@/utils/core'
import type { Desktop, LoadDesktopHostRuntimeInfo, SelectDesktopProjectPath } from '@/utils/desktop'
import type { Router } from '@angular/router'
import type { DesktopHostRuntimeInfo } from '@desktop'
import type { RecentlyProjectEntry } from 'shared'
import type { ProjectOpenSessionConflict } from './utils/types'

/**
 * 读取 desktop 宿主运行时信息。
 * @param desktop - UI 持有的 desktop ERPC 句柄
 * @param loadDesktopHostRuntimeInfo - 真实的 desktop runtime 读取函数
 */
export const loadProjectOpenRuntimeInfo = async (
	desktop: NonNullable<Desktop> | null,
	loadDesktopHostRuntimeInfo: LoadDesktopHostRuntimeInfo
) => {
	if (!desktop) return null

	try {
		return await loadDesktopHostRuntimeInfo(desktop)
	} catch {
		return null
	}
}

/**
 * 读取项目打开页的最近项目列表。
 * @param core - core 句柄
 * @param runtimeInfo - desktop 运行时信息
 * @param config - fallback config
 */
export const loadProjectOpenRecentProjects = async (
	core: Core,
	runtimeInfo: DesktopHostRuntimeInfo | null,
	config: unknown
): Promise<Array<RecentlyProjectEntry>> =>
	runtimeInfo?.appDataPath
		? ((await core.project.getStoredRecentProjects.query({ appDataPath: runtimeInfo.appDataPath })) ?? [])
		: await core.project.getRecentProjects.query({ config: config as never })

/**
 * 通过 desktop 宿主选择目标项目文件或目录。
 * @param desktop - UI 持有的 desktop ERPC 句柄
 * @param currentPath - 当前默认路径
 * @param selectDesktopProjectPath - 项目路径选择能力
 */
export const chooseProjectOpenDirectory = (
	desktop: NonNullable<Desktop> | null,
	currentPath: string,
	selectDesktopProjectPath: SelectDesktopProjectPath
) => {
	if (!desktop) return Promise.resolve('')
	return selectDesktopProjectPath(desktop, currentPath)
}

/**
 * 把用户选中的文件或目录解析成项目根目录。
 * @param core - core 句柄
 * @param inputPath - 原始输入路径
 */
export const resolveProjectOpenSelection = async (core: Core, inputPath: string) => {
	const normalized = inputPath.trim()
	if (!normalized) return ''
	return core.project.resolveOpenPath.query({ path: normalized })
}

/**
 * 读取项目目录的生命周期摘要。
 * @param core - core 句柄
 * @param projectPath - 目标项目目录
 */
export const loadProjectOpenLifecycle = (core: Core, projectPath: string) =>
	core.project.getLifecycleStatus.query({ projectPath })

/**
 * 解析当前项目是否被其他 desktop 会话占用。
 * @param projectPath - 当前预览的项目路径
 * @param lifecycle - 生命周期摘要
 * @param desktopPid - 当前 desktop 进程 pid
 */
export const resolveProjectOpenSessionConflict = (
	projectPath: string,
	lifecycle: Awaited<ReturnType<typeof loadProjectOpenLifecycle>>,
	desktopPid: number | undefined
): ProjectOpenSessionConflict | null => {
	const lockedByCurrentDesktop =
		typeof desktopPid === 'number' &&
		typeof lifecycle.openSessionLockPid === 'number' &&
		desktopPid === lifecycle.openSessionLockPid
	if (!lifecycle.hasOpenSessionLock || lifecycle.openSessionLockStale || lockedByCurrentDesktop) {
		return null
	}

	return {
		projectPath,
		owner: lifecycle.openSessionLockOwner || null,
		pid: typeof lifecycle.openSessionLockPid === 'number' ? lifecycle.openSessionLockPid : null
	}
}

/**
 * 生成项目打开锁冲突提示文案。
 * @param owner - 当前锁持有者标识
 */
export const formatProjectOpenConflictMessage = (owner: string | null) =>
	`Project is already opened by ${owner || 'another desktop session'}. Cancel to keep the current owner, or Force Open to take over the lock.`

/**
 * 打开已存在项目。
 * @param core - core 句柄
 * @param router - Angular Router
 * @param projectPath - 目标项目目录
 */
export const openExistingProject = (core: Core, router: Router, projectPath: string) =>
	openProjectInEditor(core, router, projectPath)
