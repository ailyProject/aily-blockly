import { buildFrameTarget } from '@/runtime/frame'
import { getThemeMode } from '@/runtime/theme'
import { embedTargets } from '@/workspace'

import type { DomSanitizer } from '@angular/platform-browser'
import type { GraphEditorState } from './types'

const graphEditorTarget = embedTargets.find(target => target.id === 'connection-graph') ?? embedTargets[0]

/**
 * 解析连线图页面状态。
 * @param {DomSanitizer} sanitizer - Angular 资源 URL 处理器
 * @param {string | null | undefined} rawUrl - 原始输入 URL
 * @returns {GraphEditorState}
 */
export const resolveGraphEditorState = (
	sanitizer: DomSanitizer,
	rawUrl: string | null | undefined
): GraphEditorState => {
	const fallbackUrl = `${graphEditorTarget.url}&theme=${getThemeMode()}`
	const target = buildFrameTarget(sanitizer, rawUrl, fallbackUrl)

	return {
		title: graphEditorTarget.title,
		url: target.url,
		origin: target.origin,
		frameUrl: target.frameUrl
	}
}
