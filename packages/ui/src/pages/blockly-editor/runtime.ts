import { boardIndex, config, legacyBoards, legacyLibraries, libraryIndex, toolbarApps } from '@/workspace'

import { blocklyEditorSearchSeed } from './data'

import type { Core } from '@/utils/core'
import type { BlocklyEditorState } from './types'

const summarizeActivePageState = (snapshot: Awaited<ReturnType<Core['project']['readDocument']['query']>>) => {
	const activePage = snapshot.document.pages.find(page => page.id === snapshot.document.activePageId)

	return {
		activePageTitle: activePage?.title,
		activeViewState: activePage?.viewState
	}
}

export const searchBlocklyEditorCatalog = async (core: Core, query: string) => {
	const compatResults = await core.hardware.searchCompat.query({
		boards: boardIndex,
		libraries: libraryIndex,
		query: { query, type: 'both', maxResults: 4 },
		legacy: { legacyBoards, legacyLibraries }
	})

	return compatResults.map(item => item.displayName)
}

export const loadBlocklyEditorAbiSummary = async (core: Core, projectPath: string) =>
	projectPath
		? core.project.readAbiSummary.query({
				projectPath
			})
		: null

export const loadBlocklyEditorState = async (core: Core, projectPath: string): Promise<BlocklyEditorState> => {
	const [
		categories,
		boardValidation,
		libraryValidation,
		libraryStatus,
		configSummary,
		layoutSummary,
		compatResults,
		abiSummary,
		documentSnapshot,
		activeWorkspace
	] = await Promise.all([
		core.hardware.getBoardCategories.query({ boards: boardIndex, dimension: 'architecture' }),
		core.hardware.validateLegacyBoard.query({ boardName: 'esp32s3 xiao', boards: legacyBoards }),
		core.hardware.validateLegacyLibrary.query({ libraryName: 'rc522 reader', libraries: legacyLibraries }),
		projectPath ? core.project.getBlocklyLibraryStatus.query({ projectPath }) : null,
		core.config.get.query({ config, fallbackLanguage: config.lang }),
		core.store.resolveLayout.query({
			config,
			apps: toolbarApps,
			defaultToolbarAppIds: config.toolbarAppIds ?? [],
			context: { routeUrl: '/main/blockly-editor', boardCore: 'esp32', isDevMode: false }
		}),
		searchBlocklyEditorCatalog(core, blocklyEditorSearchSeed),
		loadBlocklyEditorAbiSummary(core, projectPath),
		projectPath ? core.project.readDocument.query({ projectPath }) : null,
		projectPath ? core.project.readActiveWorkspace.query({ projectPath }) : null
	])
	const activePageState = documentSnapshot ? summarizeActivePageState(documentSnapshot) : null

	return {
		projectPath,
		categories: categories.categories,
		boardValidation: boardValidation.exists ? (boardValidation.board?.name ?? 'matched') : 'not found',
		libraryValidation: libraryValidation.exists ? (libraryValidation.library?.name ?? 'matched') : 'not found',
		toolbarCount: configSummary.toolbarAppIds.length,
		visibleToolbarCount: layoutSummary.visibleHeaderIds.length,
		language: configSummary.selectedLanguage,
		searchResultNames: compatResults,
		abiExists: abiSummary?.exists ?? false,
		abiFilePath: abiSummary?.filePath ?? '',
		abiParseError: abiSummary?.parseError,
		abiSchemaVersion: abiSummary?.schemaVersion,
		activePageId: abiSummary?.activePageId,
		openedPageCount: abiSummary?.openedPageCount ?? 0,
		pageCount: abiSummary?.pageCount ?? 0,
		totalBlockCount: abiSummary?.totalBlockCount ?? 0,
		activePageTitle: activePageState?.activePageTitle,
		activeViewState: activePageState?.activeViewState,
		activeWorkspace: {
			topLevelBlockCount: activeWorkspace?.topLevelBlockCount ?? 0,
			topLevelBlockTypes: activeWorkspace?.topLevelBlockTypes ?? [],
			workspaceJson: JSON.stringify(activeWorkspace?.workspace ?? {}, null, 2)
		},
		sharedVariableCount: abiSummary?.sharedVariableCount ?? 0,
		sharedProcedureCount: abiSummary?.sharedProcedureCount ?? 0,
		pages: abiSummary?.pages ?? [],
		missingLibraries: libraryStatus?.missingLibraries ?? []
	}
}
