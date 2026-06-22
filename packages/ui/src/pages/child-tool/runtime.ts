import { buildFrameTarget } from '@/runtime/frame'
import { loadDesktopHostRuntimeInfo } from '@/utils/desktop'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { DomSanitizer } from '@angular/platform-browser'
import type { ChildToolListItem, ChildToolPageHostInfo, ChildToolPageState } from './types'

const resolveChildPath = async (desktop: NonNullable<Desktop> | null) => {
	if (!desktop) return undefined

	const runtimeInfo = await loadDesktopHostRuntimeInfo(desktop)
	return runtimeInfo.available ? runtimeInfo.childPath : undefined
}

/**
 * 加载子工具目录。
 * @param core - core 服务句柄
 * @param desktop - desktop ERPC 句柄
 */
export const loadChildTools = async (
	core: Core,
	desktop: NonNullable<Desktop> | null
): Promise<Array<ChildToolListItem>> => {
	const childPath = await resolveChildPath(desktop)
	return core.tool.list.query({ childPath })
}

/**
 * 尝试启动真实子工具宿主。
 * @param core - core 服务句柄
 * @param desktop - desktop ERPC 句柄
 * @param toolId - 子工具标识
 */
export const acquireChildToolPageHost = async (
	core: Core,
	desktop: NonNullable<Desktop> | null,
	toolId: string
): Promise<ChildToolPageHostInfo | null> => {
	const childPath = await resolveChildPath(desktop)
	if (!childPath) return null

	return core.tool.acquire.query({
		toolId,
		childPath
	})
}

/**
 * 释放真实子工具宿主。
 * @param core - core 服务句柄
 * @param toolId - 子工具标识
 */
export const releaseChildToolPageHost = (core: Core, toolId: string) =>
	core.tool.release.query({
		toolId
	})

/**
 * 解析子工具页面状态。
 * @param sanitizer - Angular 资源 URL 处理器
 * @param tools - 子工具目录
 * @param toolId - 当前子工具标识
 * @param rawUrl - 原始输入 URL
 * @param hostInfo - 当前宿主信息
 */
export const resolveChildToolPageState = (
	sanitizer: DomSanitizer,
	tools: Array<ChildToolListItem>,
	toolId: string | null | undefined,
	rawUrl: string | null | undefined,
	hostInfo: ChildToolPageHostInfo | null = null
): ChildToolPageState => {
	const tool = tools.find(item => item.id === toolId) ?? null
	const resolvedUrl = hostInfo?.url || rawUrl

	if (!resolvedUrl) {
		return {
			tool,
			url: null,
			origin: null,
			frameUrl: null,
			hostInfo
		}
	}

	const target = buildFrameTarget(sanitizer, resolvedUrl, resolvedUrl)
	return {
		tool,
		url: target.url,
		origin: target.origin,
		frameUrl: target.frameUrl,
		hostInfo
	}
}

/**
 * 重启真实子工具宿主。
 * @param core - core 服务句柄
 * @param desktop - desktop ERPC 句柄
 * @param toolId - 子工具标识
 */
export const restartChildToolPageHost = async (
	core: Core,
	desktop: NonNullable<Desktop> | null,
	toolId: string
): Promise<ChildToolPageHostInfo | null> => {
	const childPath = await resolveChildPath(desktop)
	if (!childPath) return null

	return core.tool.restart.query({
		toolId,
		childPath
	})
}
