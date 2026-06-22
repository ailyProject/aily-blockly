import { openProjectInEditor } from '@/runtime/project-routing'
import { getCurrentProjectPath, setCurrentProjectEditorRoute, setCurrentProjectPath } from '@/runtime/project-session'

import { getCore } from './core'
import { getDesktop } from './desktop.client'
import { syncDesktopCoreBridge } from './desktop.core'
import { consumeDesktopPendingProjectOpen } from './desktop.host'

import type { Router as AngularRouter } from '@angular/router'

/**
 * 在应用启动时尝试消费 desktop 传来的待打开项目路径。
 * @param router - Angular Router
 */
export const initializeDesktopPendingProjectOpen = async (router: AngularRouter) => {
	const desktop = getDesktop()
	if (!desktop) return false

	await syncDesktopCoreBridge(desktop).catch(() => null)
	const pending = await consumeDesktopPendingProjectOpen(desktop).catch(() => null)
	const rawPath = pending?.path?.trim()
	if (!rawPath) return false

	const core = getCore()
	const projectPath = await core.project.resolveOpenPath.query({ path: rawPath }).catch(() => '')
	if (!projectPath) return false
	await openProjectInEditor(core, router, projectPath).catch(() => null)
	return true
}

/**
 * 在没有 desktop 待打开项目时，尝试恢复本地持久化的项目会话。
 * @param router - Angular Router
 */
export const initializeStoredProjectSession = async (router: AngularRouter) => {
	const storedPath = getCurrentProjectPath().trim()
	if (!storedPath) return

	const core = getCore()
	const projectPath = await core.project.resolveOpenPath.query({ path: storedPath }).catch(() => '')
	if (!projectPath) {
		setCurrentProjectPath('')
		setCurrentProjectEditorRoute('')
		return
	}

	const lifecycle = await core.project.getLifecycleStatus.query({ projectPath }).catch(() => null)
	if (!lifecycle?.hasPackageJson) {
		setCurrentProjectPath('')
		setCurrentProjectEditorRoute('')
		return
	}

	await openProjectInEditor(core, router, projectPath).catch(() => null)
}
