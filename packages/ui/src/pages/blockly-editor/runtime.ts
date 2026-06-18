import { boardIndex, config, legacyBoards, legacyLibraries, libraryIndex, toolbarApps } from '@/workspace'

import { blocklyEditorSearchSeed } from './data'

import type { Core } from '@/core-service'
import type { BlocklyEditorState } from './types'

export const searchBlocklyEditorCatalog = async (core: Core, query: string) => {
	const compatResults = await core.hardware.searchCompat.query({
		boards: boardIndex,
		libraries: libraryIndex,
		query: { query, type: 'both', maxResults: 4 },
		legacy: { legacyBoards, legacyLibraries }
	})

	return compatResults.map(item => item.displayName)
}

export const loadBlocklyEditorState = async (core: Core): Promise<BlocklyEditorState> => {
	const [categories, boardValidation, libraryValidation, configSummary, layoutSummary, compatResults] =
		await Promise.all([
			core.hardware.getBoardCategories.query({ boards: boardIndex, dimension: 'architecture' }),
			core.hardware.validateLegacyBoard.query({ boardName: 'esp32s3 xiao', boards: legacyBoards }),
			core.hardware.validateLegacyLibrary.query({ libraryName: 'rc522 reader', libraries: legacyLibraries }),
			core.config.get.query({ config, fallbackLanguage: config.lang }),
			core.store.resolveLayout.query({
				config,
				apps: toolbarApps,
				defaultToolbarAppIds: config.toolbarAppIds ?? [],
				context: { routeUrl: '/main/blockly-editor', boardCore: 'esp32', isDevMode: false }
			}),
			searchBlocklyEditorCatalog(core, blocklyEditorSearchSeed)
		])

	return {
		categories: categories.categories,
		boardValidation: boardValidation.exists ? (boardValidation.board?.name ?? 'matched') : 'not found',
		libraryValidation: libraryValidation.exists ? (libraryValidation.library?.name ?? 'matched') : 'not found',
		toolbarCount: configSummary.toolbarAppIds.length,
		visibleToolbarCount: layoutSummary.visibleHeaderIds.length,
		language: configSummary.selectedLanguage,
		searchResultNames: compatResults
	}
}
