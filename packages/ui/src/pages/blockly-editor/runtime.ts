import {
	seedAppConfig,
	seedBoardIndex,
	seedLegacyBoards,
	seedLegacyLibraries,
	seedLibraryIndex,
	seedToolbarApps
} from '@/pages/home/data'

import { blocklyEditorSearchSeed } from './data'

import type { Core } from '@/core-service'

export interface BlocklyEditorState {
	categories: Array<{ name: string; count: number }>
	boardValidation: string
	libraryValidation: string
	toolbarCount: number
	visibleToolbarCount: number
	language: string
	searchResultNames: Array<string>
}

export const searchBlocklyEditorCatalog = async (core: Core, query: string) => {
	const compatResults = await core.hardware.searchCompat.query({
		boards: seedBoardIndex,
		libraries: seedLibraryIndex,
		query: { query, type: 'both', maxResults: 4 },
		legacy: { legacyBoards: seedLegacyBoards, legacyLibraries: seedLegacyLibraries }
	})

	return compatResults.map(item => item.displayName)
}

export const loadBlocklyEditorState = async (core: Core): Promise<BlocklyEditorState> => {
	const [categories, boardValidation, libraryValidation, configSummary, layoutSummary, compatResults] =
		await Promise.all([
			core.hardware.getBoardCategories.query({ boards: seedBoardIndex, dimension: 'architecture' }),
			core.hardware.validateLegacyBoard.query({ boardName: 'esp32s3 xiao', boards: seedLegacyBoards }),
			core.hardware.validateLegacyLibrary.query({ libraryName: 'rc522 reader', libraries: seedLegacyLibraries }),
			core.config.get.query({ config: seedAppConfig, fallbackLanguage: seedAppConfig.lang }),
			core.store.resolveLayout.query({
				config: seedAppConfig,
				apps: seedToolbarApps,
				defaultToolbarAppIds: seedAppConfig.toolbarAppIds ?? [],
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
