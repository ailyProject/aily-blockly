import { buildFrameTarget } from '@/runtime/frame'
import { getCurrentProjectPath } from '@/runtime/project-session'
import { getThemeMode } from '@/runtime/theme'
import { embedTargets } from '@/workspace'

import type { DomSanitizer } from '@angular/platform-browser'
import type { GraphEditorState } from '../types'

const graphEditorTarget = embedTargets.find(target => target.id === 'connection-graph') ?? embedTargets[0]

/**
 * 解析连线图页面状态。
 * @param sanitizer - Angular 资源 URL 处理器
 * @param rawUrl - 原始输入 URL
 */
export const resolveGraphEditorState = (
	sanitizer: DomSanitizer,
	rawUrl: string | null | undefined,
	projectPath: string
): GraphEditorState => {
	const fallbackUrl = `${graphEditorTarget.url}&theme=${getThemeMode()}`
	const target = buildFrameTarget(sanitizer, rawUrl, fallbackUrl)
	const nextUrl = new URL(target.url)
	nextUrl.searchParams.set('theme', getThemeMode())
	if (projectPath) {
		nextUrl.searchParams.set('projectPath', projectPath)
	}

	return {
		projectPath,
		packagesBasePath: '',
		boardPackageName: '',
		boardPackagePath: '',
		title: graphEditorTarget.title,
		url: nextUrl.toString(),
		origin: nextUrl.origin,
		frameUrl: sanitizer.bypassSecurityTrustResourceUrl(nextUrl.toString()),
		jsonPath: '',
		awsPath: '',
		graphExists: false,
		awsExists: false,
		graphDescription: '',
		componentCount: 0,
		connectionCount: 0,
		awsLineCount: 0,
		libraryCount: 0,
		catalogCount: 0,
		missingCatalogCount: 0,
		libraryNames: [],
		missingCatalogNames: [],
		availablePinmapIds: [],
		sensorPickerGroups: [],
		pinmapTemplateProtocol: 'i2c',
		pinmapTemplateJson: '',
		graphJson: '',
		awsContent: '',
		pinmapHints: [],
		libraryInfo: {
			readme: '',
			exampleCode: '',
			existingPinmaps: []
		},
		promptInfo: {
			systemPrompt: '',
			userPrompt: '',
			pinSummaryCount: 0
		},
		componentConfigsJson: ''
	}
}

/**
 * 解析 graph editor 应绑定的当前项目路径。
 * @param rawPath - 路由 query 中的 path
 */
export const resolveGraphEditorProjectPath = (rawPath: string | null | undefined) =>
	rawPath || getCurrentProjectPath() || ''
