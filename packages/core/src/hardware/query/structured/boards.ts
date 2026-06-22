import { compareNumeric, includesAll, scoreText } from '../common'

import type { BoardIndexItem, HardwareSearchFilters, HardwareSearchResult } from '../../types'

/**
 * 执行结构化开发板搜索。
 * @param boards - 开发板索引列表
 * @param keywords - 关键词列表
 * @param filters - 过滤条件
 */
export const searchHardwareBoards = (
	boards: Array<BoardIndexItem>,
	keywords: Array<string>,
	filters?: HardwareSearchFilters
) =>
	boards
		.filter(board => compareNumeric(board.flash, filters?.flash))
		.filter(board => compareNumeric(board.sram, filters?.sram))
		.filter(board => compareNumeric(board.frequency, filters?.frequency))
		.filter(board => compareNumeric(board.cores, filters?.cores))
		.filter(board => !filters?.architecture || board.architecture.toLowerCase() === filters.architecture.toLowerCase())
		.filter(board => !filters?.brand || board.brand.toLowerCase() === filters.brand.toLowerCase())
		.filter(board => !filters?.voltage || compareNumeric(board.voltage, filters.voltage))
		.filter(board => includesAll(board.connectivity, filters?.connectivity))
		.filter(board => includesAll(board.interfaces, filters?.interfaces))
		.map<HardwareSearchResult>(board => {
			const matchedFields = new Set<string>()
			const matchedQueries = new Set<string>()
			let score = 0

			for (const keyword of keywords) {
				const contributions: Array<[string, number]> = [
					['name', scoreText(board.name, keyword, 120, 30)],
					['displayName', scoreText(board.displayName, keyword, 110, 25)],
					['description', scoreText(board.description ?? '', keyword, 80, 15)],
					['tags', (board.tags ?? []).reduce((sum, tag) => sum + scoreText(tag, keyword, 60, 10), 0)],
					['keywords', (board.keywords ?? []).reduce((sum, tag) => sum + scoreText(tag, keyword, 50, 10), 0)]
				]
				const keywordScore = contributions.reduce((sum, [, value]) => sum + value, 0)
				if (keywordScore > 0) matchedQueries.add(keyword)
				for (const [field, value] of contributions) if (value > 0) matchedFields.add(field)
				score += keywordScore
			}

			return {
				source: 'board',
				name: board.name,
				displayName: board.displayName,
				description: board.description ?? '',
				score,
				matchedFields: [...matchedFields],
				matchedQueries: [...matchedQueries],
				metadata: board
			}
		})
		.filter(item => keywords.length === 0 || item.score > 0)
