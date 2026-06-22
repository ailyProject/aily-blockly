import { findLegacyDescription, toKeywords } from '../common'
import { searchHardwareBoards } from './boards'
import { searchHardwareLibraries } from './libraries'

import type {
	BoardIndexItem,
	HardwareSearchQuery,
	HardwareSearchResult,
	LegacyBoardItem,
	LegacyLibraryItem,
	LibraryIndexItem
} from '../../types'

/**
 * 统一硬件搜索入口
 * @param boards - 开发板索引列表
 * @param libraries - 库索引列表
 * @param query - 搜索参数
 */
export const searchHardwareIndex = (
	boards: Array<BoardIndexItem>,
	libraries: Array<LibraryIndexItem>,
	query: HardwareSearchQuery
) => {
	const keywords = toKeywords(query.filters?.keywords ?? query.query)
	const type = query.type ?? 'both'
	const maxResults = query.maxResults ?? 50
	const results = [
		...(type === 'boards' || type === 'both' ? searchHardwareBoards(boards, keywords, query.filters) : []),
		...(type === 'libraries' || type === 'both' ? searchHardwareLibraries(libraries, keywords, query.filters) : [])
	]

	return results.sort((left, right) => right.score - left.score).slice(0, maxResults)
}

/**
 * 用 legacy 描述回填当前搜索结果。
 * @param results - 当前搜索结果
 * @param legacy - legacy 数据集
 */
export const applyLegacyDescriptionFallback = (
	results: Array<HardwareSearchResult>,
	legacy?: { legacyBoards?: Array<LegacyBoardItem>; legacyLibraries?: Array<LegacyLibraryItem> }
) =>
	results.map(result => ({
		...result,
		description:
			result.description ||
			(result.source === 'board'
				? findLegacyDescription(result.name, legacy?.legacyBoards)
				: findLegacyDescription(result.name, legacy?.legacyLibraries)) ||
			result.displayName
	}))
