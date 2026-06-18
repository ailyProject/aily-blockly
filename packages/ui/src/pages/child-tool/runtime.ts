import { buildFrameTarget } from '@/runtime/frame'
import { childTools } from '@/workspace'

import type { DomSanitizer } from '@angular/platform-browser'
import type { ChildToolPageState } from './types'

/**
 * 解析子工具页面状态。
 * @param {DomSanitizer} sanitizer - Angular 资源 URL 处理器
 * @param {string | null | undefined} toolId - 当前子工具标识
 * @param {string | null | undefined} rawUrl - 原始输入 URL
 * @returns {ChildToolPageState}
 */
export const resolveChildToolPageState = (
	sanitizer: DomSanitizer,
	toolId: string | null | undefined,
	rawUrl: string | null | undefined
): ChildToolPageState => {
	const tool = childTools.find(item => item.id === toolId) ?? null

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
