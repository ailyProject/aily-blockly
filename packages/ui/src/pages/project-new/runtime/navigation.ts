import { openProjectInEditor } from '@/runtime/project-routing'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { Router } from '@angular/router'
import type { DesktopHostRuntimeInfo } from '@desktop'

/**
 * 读取 desktop 宿主运行时信息。
 * @param desktop - UI 持有的 desktop ERPC 句柄
 * @param loadDesktopHostRuntimeInfo - 真实的 desktop runtime 读取函数
 */
export const loadProjectNewRuntimeInfo = async (
	desktop: NonNullable<Desktop> | null,
	loadDesktopHostRuntimeInfo: (desktop: NonNullable<Desktop>) => Promise<DesktopHostRuntimeInfo>
) => {
	if (!desktop) return null

	try {
		return await loadDesktopHostRuntimeInfo(desktop)
	} catch {
		return null
	}
}

/**
 * 打开新创建或导入完成的项目。
 * @param core - Core tRPC 句柄
 * @param router - Angular Router
 * @param projectPath - 目标项目路径
 */
export const openProjectNewProject = async (core: Core, router: Router, projectPath: string) => {
	await openProjectInEditor(core, router, projectPath)
}
