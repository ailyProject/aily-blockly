import { calculateSimilarity, extractKeywords } from './keywords'

import type { BoardValidationResult, LegacyBoardItem, LegacyLibraryItem, LibraryValidationResult } from '../types'

const fuzzyThreshold = 0.3

const findBestLegacyLibrary = (libraryName: string, libraries: Array<LegacyLibraryItem>) => {
	const queryLower = libraryName.toLowerCase().trim()

	const exactName = libraries.find(library => library.name?.toLowerCase() === queryLower)
	if (exactName) return { item: exactName, fuzzyMatch: false }

	const exactNickname = libraries.find(library => library.nickname?.toLowerCase() === queryLower)
	if (exactNickname) return { item: exactNickname, fuzzyMatch: false }

	const queryKeywords = extractKeywords(queryLower)
	const candidates = libraries
		.map(library => {
			const nameScore = calculateSimilarity(queryLower, library.name?.toLowerCase() || '')
			const nicknameScore = calculateSimilarity(queryLower, library.nickname?.toLowerCase() || '')
			let keywordScore = 0

			for (const queryKeyword of queryKeywords) {
				for (const libraryKeyword of library.keywords ?? []) {
					const normalizedKeyword = libraryKeyword.toLowerCase()
					if (normalizedKeyword === queryKeyword) {
						keywordScore += 0.8
					} else if (normalizedKeyword.includes(queryKeyword) || queryKeyword.includes(normalizedKeyword)) {
						keywordScore += 0.4
					}
				}
			}

			let descriptionScore = 0
			const description = library.description?.toLowerCase() || ''
			for (const queryKeyword of queryKeywords) {
				if (description.includes(queryKeyword)) {
					descriptionScore += 0.3
				}
			}

			return {
				item: library,
				score: Math.max(nameScore, nicknameScore) + keywordScore + descriptionScore
			}
		})
		.filter(candidate => candidate.score > fuzzyThreshold)
		.sort((left, right) => right.score - left.score)

	return candidates[0] ? { item: candidates[0].item, fuzzyMatch: true } : null
}

const findBestLegacyBoard = (boardName: string, boards: Array<LegacyBoardItem>) => {
	const queryLower = boardName.toLowerCase().trim()

	const exactName = boards.find(board => board.name?.toLowerCase() === queryLower)
	if (exactName) return { item: exactName, fuzzyMatch: false }

	const exactNickname = boards.find(
		board => board.nickname?.toLowerCase() === queryLower || board.displayName?.toLowerCase() === queryLower
	)
	if (exactNickname) return { item: exactNickname, fuzzyMatch: false }

	const queryKeywords = extractKeywords(queryLower)
	const candidates = boards
		.map(board => {
			const nameScore = calculateSimilarity(queryLower, board.name?.toLowerCase() || '')
			const nicknameScore = calculateSimilarity(queryLower, board.nickname?.toLowerCase() || '')
			const displayNameScore = calculateSimilarity(queryLower, (board.displayName || '').toLowerCase())

			let descriptionScore = 0
			const description = board.description?.toLowerCase() || ''
			for (const queryKeyword of queryKeywords) {
				if (description.includes(queryKeyword)) {
					descriptionScore += 0.3
				}
			}

			return {
				item: board,
				score: Math.max(nameScore, nicknameScore, displayNameScore) + descriptionScore
			}
		})
		.filter(candidate => candidate.score > fuzzyThreshold)
		.sort((left, right) => right.score - left.score)

	return candidates[0] ? { item: candidates[0].item, fuzzyMatch: true } : null
}

/**
 * 验证旧格式库是否存在，并在必要时返回模糊匹配结果。
 * @param libraryName - 待验证库名
 * @param libraries - 旧格式库列表
 */
export const validateLegacyLibrary = (
	libraryName: string,
	libraries: Array<LegacyLibraryItem>
): LibraryValidationResult => {
	if (!libraryName) {
		return { exists: false, library: null, fuzzyMatch: false, originalQuery: libraryName }
	}

	const match = findBestLegacyLibrary(libraryName, libraries)
	return match
		? { exists: true, library: match.item, fuzzyMatch: match.fuzzyMatch, originalQuery: libraryName }
		: { exists: false, library: null, fuzzyMatch: false, originalQuery: libraryName }
}

/**
 * 验证旧格式开发板是否存在，并在必要时返回模糊匹配结果。
 * @param boardName - 待验证开发板名
 * @param boards - 旧格式开发板列表
 */
export const validateLegacyBoard = (boardName: string, boards: Array<LegacyBoardItem>): BoardValidationResult => {
	if (!boardName) {
		return { exists: false, board: null, fuzzyMatch: false, originalQuery: boardName }
	}

	const match = findBestLegacyBoard(boardName, boards)
	return match
		? { exists: true, board: match.item, fuzzyMatch: match.fuzzyMatch, originalQuery: boardName }
		: { exists: false, board: null, fuzzyMatch: false, originalQuery: boardName }
}
