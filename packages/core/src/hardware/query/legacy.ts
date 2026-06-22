import { convertFiltersToQueries, toKeywords } from './common'
import { applyLegacyDescriptionFallback, searchHardwareIndex } from './structured'

import type {
	HardwareLegacySearchInput,
	HardwareSearchQuery,
	HardwareSearchResult,
	LegacyBoardItem,
	LegacyLibraryItem
} from '../types'

const searchLegacyBoards = (boards: Array<LegacyBoardItem>, keywords: Array<string>) => {
	const results: Array<HardwareSearchResult> = []
	if (keywords.length === 0) return results

	for (const board of boards) {
		const haystack = [board.name, board.nickname, board.description, ...(board.keywords ?? []), board.brand]
			.filter(Boolean)
			.join(' ')
			.toLowerCase()
		const matchedQueries = keywords.filter(keyword => haystack.includes(keyword))
		if (matchedQueries.length === 0) continue

		results.push({
			source: 'board',
			name: board.name,
			displayName: board.nickname || board.name,
			description: board.description ?? '',
			score: matchedQueries.length * 10,
			matchedFields: ['legacy-text'],
			matchedQueries,
			metadata: undefined
		})
	}

	return results
}

const searchLegacyLibraries = (libraries: Array<LegacyLibraryItem>, keywords: Array<string>) => {
	const results: Array<HardwareSearchResult> = []
	if (keywords.length === 0) return results

	for (const library of libraries) {
		const haystack = [
			library.name,
			library.nickname,
			library.description,
			...(library.keywords ?? []),
			...(library.compatibility?.core ?? []),
			library.author
		]
			.filter(Boolean)
			.join(' ')
			.toLowerCase()
		const matchedQueries = keywords.filter(keyword => haystack.includes(keyword))
		if (matchedQueries.length === 0) continue

		results.push({
			source: 'library',
			name: library.name,
			displayName: library.nickname || library.name,
			description: library.description ?? '',
			score: matchedQueries.length * 10,
			matchedFields: ['legacy-text'],
			matchedQueries,
			metadata: undefined
		})
	}

	return results
}

export const searchHardwareIndexCompat = (
	boards: Array<import('../types').BoardIndexItem>,
	libraries: Array<import('../types').LibraryIndexItem>,
	query: HardwareSearchQuery,
	legacy?: HardwareLegacySearchInput
) => {
	if (boards.length > 0 || libraries.length > 0) {
		return applyLegacyDescriptionFallback(searchHardwareIndex(boards, libraries, query), legacy)
	}

	const type = query.type ?? 'both'
	const keywords = [
		...toKeywords(query.filters?.keywords ?? query.query),
		...convertFiltersToQueries(query.filters, type === 'libraries' ? 'libraries' : 'boards')
	]
	const legacyResults = [
		...(type === 'boards' || type === 'both' ? searchLegacyBoards(legacy?.legacyBoards ?? [], keywords) : []),
		...(type === 'libraries' || type === 'both' ? searchLegacyLibraries(legacy?.legacyLibraries ?? [], keywords) : [])
	]

	return legacyResults.slice(0, query.maxResults ?? 50)
}
