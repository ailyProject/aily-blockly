import {
	calculateLegacyDescriptionScore,
	calculateLegacySimilarity,
	createLegacyQueryKeywords,
	fuzzyThreshold
} from './shared'

import type { LegacyLibraryItem, LibraryValidationResult } from '../../types'

const findBestLegacyLibrary = (libraryName: string, libraries: Array<LegacyLibraryItem>) => {
	const queryLower = libraryName.toLowerCase().trim()

	const exactName = libraries.find(library => library.name?.toLowerCase() === queryLower)
	if (exactName) return { item: exactName, fuzzyMatch: false }

	const exactNickname = libraries.find(library => library.nickname?.toLowerCase() === queryLower)
	if (exactNickname) return { item: exactNickname, fuzzyMatch: false }

	const queryKeywords = createLegacyQueryKeywords(queryLower)
	const candidates = libraries
		.map(library => {
			const nameScore = calculateLegacySimilarity(queryLower, library.name)
			const nicknameScore = calculateLegacySimilarity(queryLower, library.nickname)
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

			return {
				item: library,
				score:
					Math.max(nameScore, nicknameScore) +
					keywordScore +
					calculateLegacyDescriptionScore(library.description, queryKeywords)
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
