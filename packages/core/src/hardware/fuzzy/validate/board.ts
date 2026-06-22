import {
	calculateLegacyDescriptionScore,
	calculateLegacySimilarity,
	createLegacyQueryKeywords,
	fuzzyThreshold
} from './shared'

import type { BoardValidationResult, LegacyBoardItem } from '../../types'

const findBestLegacyBoard = (boardName: string, boards: Array<LegacyBoardItem>) => {
	const queryLower = boardName.toLowerCase().trim()

	const exactName = boards.find(board => board.name?.toLowerCase() === queryLower)
	if (exactName) return { item: exactName, fuzzyMatch: false }

	const exactNickname = boards.find(
		board => board.nickname?.toLowerCase() === queryLower || board.displayName?.toLowerCase() === queryLower
	)
	if (exactNickname) return { item: exactNickname, fuzzyMatch: false }

	const queryKeywords = createLegacyQueryKeywords(queryLower)
	const candidates = boards
		.map(board => {
			const nameScore = calculateLegacySimilarity(queryLower, board.name)
			const nicknameScore = calculateLegacySimilarity(queryLower, board.nickname)
			const displayNameScore = calculateLegacySimilarity(queryLower, board.displayName)

			return {
				item: board,
				score:
					Math.max(nameScore, nicknameScore, displayNameScore) +
					calculateLegacyDescriptionScore(board.description, queryKeywords)
			}
		})
		.filter(candidate => candidate.score > fuzzyThreshold)
		.sort((left, right) => right.score - left.score)

	return candidates[0] ? { item: candidates[0].item, fuzzyMatch: true } : null
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
