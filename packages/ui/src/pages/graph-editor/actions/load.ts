import {
	extractGraphEditorPinmapHints,
	loadGraphEditorAssets,
	loadGraphEditorComponentConfigs,
	loadGraphEditorLibraryInfo,
	loadGraphEditorLibraryState,
	loadGraphEditorPinmapState,
	loadGraphEditorPinmapTemplate,
	loadGraphEditorPromptInfo,
	loadGraphEditorWorkspaceState,
	resolveGraphEditorState
} from '../runtime'

import type { Core } from '@/utils/core'
import type { Desktop } from '@/utils/desktop'
import type { DomSanitizer } from '@angular/platform-browser'
import type { ActivatedRoute } from '@angular/router'
import type { GraphEditorSignals } from '../component.types'

/**
 * 创建 Graph Editor 载入与切换动作。
 * @param input - 页面信号、路由上下文与外部依赖
 */
export const createGraphEditorLoadActions = (input: {
	core: Core
	desktop: NonNullable<Desktop> | null
	route: ActivatedRoute
	sanitizer: DomSanitizer
	signals: GraphEditorSignals
	selectDesktopDirectory: (desktop: NonNullable<Desktop>, path: string) => Promise<string>
	setCurrentProjectPath: (projectPath: string) => void
}) => ({
	async load() {
		input.signals.loading.set(true)
		input.signals.error.set(null)
		try {
			const assets = await loadGraphEditorAssets(input.core, input.signals.state().projectPath)
			input.signals.graphJson.set(assets.graphJson)
			const pinmapHints = extractGraphEditorPinmapHints(assets.graphJson)
			input.signals.pinmapHints.set(pinmapHints)
			if (!input.signals.pinmapId() && pinmapHints[0]) {
				input.signals.pinmapId.set(pinmapHints[0])
			}
			input.signals.awsContent.set(assets.awsContent)
			input.signals.graphJsonDirty.set(false)
			input.signals.graphJsonError.set(null)
			input.signals.awsDirty.set(false)
			input.signals.saveMessage.set(null)
			const workspaceState = await loadGraphEditorWorkspaceState(input.core, input.signals.state().projectPath)
			if (workspaceState) {
				input.signals.state.update(current => ({ ...current, ...workspaceState }))
				const libraryState = await loadGraphEditorLibraryState(input.core, workspaceState.packagesBasePath)
				const pinmapState = await loadGraphEditorPinmapState(input.core, workspaceState.packagesBasePath)
				const templateState = await loadGraphEditorPinmapTemplate(input.core, input.signals.pinmapTemplateProtocol())
				const connectionData = assets.graphJson.trim() ? JSON.parse(assets.graphJson) : null
				const libraryInfo = await loadGraphEditorLibraryInfo(
					input.core,
					input.signals.pinmapId(),
					workspaceState.packagesBasePath
				)
				const promptInfo = await loadGraphEditorPromptInfo({
					core: input.core,
					boardPackagePath: workspaceState.boardPackagePath
				})
				const componentConfigsJson = connectionData
					? await loadGraphEditorComponentConfigs({
							core: input.core,
							boardPackagePath: workspaceState.boardPackagePath,
							packagesBasePath: workspaceState.packagesBasePath,
							connectionData
						})
					: ''
				input.signals.pinmapTemplateJson.set(templateState.pinmapTemplateJson)
				input.signals.pinmapJson.set(templateState.pinmapTemplateJson)
				input.signals.pinmapJsonError.set(null)
				input.signals.state.update(current => ({
					...current,
					...libraryState,
					...pinmapState,
					...templateState,
					...libraryInfo,
					promptInfo,
					componentConfigsJson
				}))
			}
		} catch (error) {
			input.signals.error.set((error as Error).message)
		} finally {
			input.signals.loading.set(false)
		}
	},
	async refreshLibraryInfo() {
		const libraryInfo = await loadGraphEditorLibraryInfo(
			input.core,
			input.signals.pinmapId(),
			input.signals.state().packagesBasePath
		)
		input.signals.state.update(current => ({ ...current, ...libraryInfo }))
	},
	async chooseProjectPath() {
		if (!input.desktop) return
		const nextPath = await input.selectDesktopDirectory(input.desktop, input.signals.state().projectPath)
		if (!nextPath) return

		input.setCurrentProjectPath(nextPath)
		input.signals.state.set(
			resolveGraphEditorState(input.sanitizer, input.route.snapshot.queryParamMap.get('url'), nextPath)
		)
		await this.load()
	}
})
