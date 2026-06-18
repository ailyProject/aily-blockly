import { buildFrameTarget } from '@/runtime/frame'

import type { Core } from '@/core-service'
import type { DomSanitizer } from '@angular/platform-browser'
import type { ChildToolListItem, ChildToolPageState } from './types'

/**
 * 加载子工具目录。
 * @param {Core} core - core 服务句柄
 * @returns {Promise<Array<ChildToolListItem>>}
 */
export const loadChildTools = async (core: Core): Promise<Array<ChildToolListItem>> => core.tool.list.query({})

/**
 * 解析子工具页面状态。
 * @param {DomSanitizer} sanitizer - Angular 资源 URL 处理器
 * @param {Array<ChildToolListItem>} tools - 子工具目录
 * @param {string | null | undefined} toolId - 当前子工具标识
 * @param {string | null | undefined} rawUrl - 原始输入 URL
 * @returns {ChildToolPageState}
 */
export const resolveChildToolPageState = (
	sanitizer: DomSanitizer,
	tools: Array<ChildToolListItem>,
	toolId: string | null | undefined,
	rawUrl: string | null | undefined
): ChildToolPageState => {
	const tool = tools.find(item => item.id === toolId) ?? null

	if (!rawUrl) {
		return {
			tool,
			url: null,
			origin: null,
			frameUrl: null
		}
	}

	const target = buildFrameTarget(sanitizer, rawUrl, rawUrl)
	return {
		tool,
		url: target.url,
		origin: target.origin,
		frameUrl: target.frameUrl
	}
}
