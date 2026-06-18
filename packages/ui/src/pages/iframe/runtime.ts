import { buildFrameTarget } from '@/runtime/frame'
import { embedTargets } from '@/workspace'

import type { DomSanitizer } from '@angular/platform-browser'
import type { IframePageState } from './types'

const defaultIframeTarget = embedTargets[0]

/**
 * 解析 iframe 页面状态。
 * @param {DomSanitizer} sanitizer - Angular 资源 URL 处理器
 * @param {string | null | undefined} rawUrl - 原始输入 URL
 * @param {string | null | undefined} rawTitle - 原始标题
 * @returns {IframePageState}
 */
export const resolveIframePageState = (
	sanitizer: DomSanitizer,
	rawUrl: string | null | undefined,
	rawTitle: string | null | undefined
): IframePageState => {
	const target = buildFrameTarget(sanitizer, rawUrl, defaultIframeTarget.url)

	return {
		title: rawTitle?.trim() || defaultIframeTarget.title,
		url: target.url,
		origin: target.origin,
		frameUrl: target.frameUrl
	}
}
