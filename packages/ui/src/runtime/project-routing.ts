import { getDesktop, loadDesktopHostRuntimeInfo } from '@/utils/desktop'

import {
	clearCurrentProjectSession,
	getCurrentProjectPath,
	setCurrentProjectEditorRoute,
	setCurrentProjectPath,
	setCurrentProjectSourceCode
} from './project-session'

import type { Core } from '@/utils/core'
import type { Router } from '@angular/router'

const syncProjectOpenSessionLock = async (core: Core, nextProjectPath: string) => {
	const desktop = getDesktop()
	if (!desktop) return

	const runtimeInfo = await loadDesktopHostRuntimeInfo(desktop).catch(() => null)
	if (!runtimeInfo?.available) return

	const currentProjectPath = getCurrentProjectPath().trim()
	if (currentProjectPath && currentProjectPath !== nextProjectPath) {
		await core.project.releaseOpenSessionLock
			.mutate({
				projectPath: currentProjectPath,
				pid: runtimeInfo.pid
			})
			.catch(() => null)
	}

	await core.project.acquireOpenSessionLock.mutate({
		projectPath: nextProjectPath,
		owner: 'desktop-ui-session',
		pid: runtimeInfo.pid
	})
}

/**
 * 打开指定项目并跳转到对应编辑器。
 * @param core - Core tRPC 句柄
 * @param router - Angular Router
 * @param projectPath - 目标项目路径
 */
export const openProjectInEditor = async (core: Core, router: Router, projectPath: string) => {
	await syncProjectOpenSessionLock(core, projectPath)
	setCurrentProjectPath(projectPath)
	setCurrentProjectSourceCode('')
	const route = await core.project.resolveEditorRoute.query({ projectPath })
	setCurrentProjectEditorRoute(route)
	await router.navigate([`/main/${route}`], {
		queryParams: { path: projectPath },
		replaceUrl: true
	})
}

/**
 * 关闭当前项目会话并释放打开锁。
 * @param core - Core tRPC 句柄
 * @param router - Angular Router
 */
export const closeProjectInEditor = async (core: Core, router: Router) => {
	const currentProjectPath = getCurrentProjectPath().trim()
	const desktop = getDesktop()
	if (currentProjectPath && desktop) {
		const runtimeInfo = await loadDesktopHostRuntimeInfo(desktop).catch(() => null)
		if (runtimeInfo?.available) {
			await core.project.releaseOpenSessionLock
				.mutate({
					projectPath: currentProjectPath,
					pid: runtimeInfo.pid
				})
				.catch(() => null)
		}
	}

	clearCurrentProjectSession()
	await router.navigate(['/main/guide'], { replaceUrl: true })
}
