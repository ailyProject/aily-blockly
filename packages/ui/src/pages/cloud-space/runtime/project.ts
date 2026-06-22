import { openProjectInEditor } from '@/runtime/project-routing'

import type { Core } from '@/utils/core'
import type { Desktop, SelectDesktopDirectory } from '@/utils/desktop'
import type { Router } from '@angular/router'
import type { DesktopHostRuntimeInfo } from '@desktop'

/**
 * 读取 desktop 宿主运行时信息。
 * @param desktop - UI 持有的 desktop ERPC 句柄
 * @param loadDesktopHostRuntimeInfo - 真实的 desktop runtime 读取函数
 */
export const loadCloudSpaceRuntimeInfo = async (
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
 * 通过 desktop 宿主挑选新的导入根目录。
 * @param desktop - UI 持有的 desktop ERPC 句柄
 * @param rootPath - 当前根目录
 * @param selectDesktopDirectory - desktop 目录选择函数
 */
export const chooseCloudSpaceRootPath = async (
	desktop: NonNullable<Desktop> | null,
	rootPath: string,
	selectDesktopDirectory: SelectDesktopDirectory
) => {
	if (!desktop) return ''
	return selectDesktopDirectory(desktop, rootPath)
}

/**
 * 打开刚导入完成的本地项目。
 * @param core - Core tRPC 句柄
 * @param router - Angular Router
 * @param projectPath - 需要打开的本地项目路径
 */
export const openCloudSpaceProject = async (core: Core, router: Router, projectPath: string) => {
	await openProjectInEditor(core, router, projectPath)
}
