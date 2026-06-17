import type {
	BoardIndexItem,
	HardwareSearchFilters,
	HardwareSearchQuery,
	HardwareSearchResult,
	LibraryIndexItem
} from './types'

const toKeywords = (input?: string | Array<string>) => {
	if (!input) return []
	if (Array.isArray(input)) return input.map(item => item.trim().toLowerCase()).filter(Boolean)

	return input
		.split(/[,，]/)
		.flatMap(part => part.trim().split(/\s+/))
		.map(item => item.trim().toLowerCase())
		.filter(Boolean)
}

const compareNumeric = (value: number, condition?: string) => {
	if (!condition) return true

	const match = condition.match(/^([<>=!]+)?(\d+(?:\.\d+)?)$/)
	if (!match) return true

	const [, operator, raw] = match
	const expected = Number(raw)

	switch (operator) {
		case '>':
			return value > expected
		case '>=':
			return value >= expected
		case '<':
			return value < expected
		case '<=':
			return value <= expected
		case '!=':
			return value !== expected
		default:
			return value === expected
	}
}

const includesAll = (source: Array<string>, expected?: Array<string>) =>
	!expected?.length || expected.every(item => source.some(value => value.toLowerCase() === item.toLowerCase()))

const scoreText = (value: string, query: string, exact: number, partial: number) => {
	const normalized = value.toLowerCase()
	if (normalized === query) return exact
	if (normalized.includes(query)) return partial
	return 0
}

/** 中文注释：对开发板执行结构化筛选与文本评分，输出稳定的核心搜索结果。 */
const searchBoards = (boards: Array<BoardIndexItem>, keywords: Array<string>, filters?: HardwareSearchFilters) =>
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
				for (const [field, value] of contributions) {
					if (value > 0) matchedFields.add(field)
				}
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

/** 中文注释：对库索引执行结构化筛选与文本评分，保持 agent 和 UI 侧结果口径一致。 */
const searchLibraries = (
	libraries: Array<LibraryIndexItem>,
	keywords: Array<string>,
	filters?: HardwareSearchFilters
) =>
	libraries
		.filter(library => !filters?.category || library.category.toLowerCase() === filters.category.toLowerCase())
		.filter(library => includesAll(library.hardwareType, filters?.hardwareType))
		.filter(library => includesAll(library.communication, filters?.communication))
		.filter(
			library =>
				!filters?.supportedCores?.length ||
				filters.supportedCores.some(core =>
					library.supportedCores.some(item => item.toLowerCase() === core.toLowerCase())
				)
		)
		.map<HardwareSearchResult>(library => {
			const matchedFields = new Set<string>()
			const matchedQueries = new Set<string>()
			let score = 0

			for (const keyword of keywords) {
				const contributions: Array<[string, number]> = [
					['name', scoreText(library.name, keyword, 120, 30)],
					['displayName', scoreText(library.displayName, keyword, 110, 25)],
					['description', scoreText(library.description ?? '', keyword, 80, 15)],
					['tags', (library.tags ?? []).reduce((sum, tag) => sum + scoreText(tag, keyword, 60, 10), 0)],
					['keywords', (library.keywords ?? []).reduce((sum, tag) => sum + scoreText(tag, keyword, 50, 10), 0)]
				]

				const keywordScore = contributions.reduce((sum, [, value]) => sum + value, 0)
				if (keywordScore > 0) matchedQueries.add(keyword)
				for (const [field, value] of contributions) {
					if (value > 0) matchedFields.add(field)
				}
				score += keywordScore
			}

			return {
				source: 'library',
				name: library.name,
				displayName: library.displayName,
				description: library.description ?? '',
				score,
				matchedFields: [...matchedFields],
				matchedQueries: [...matchedQueries],
				metadata: library
			}
		})
		.filter(item => keywords.length === 0 || item.score > 0)

/** 中文注释：统一硬件搜索入口，优先服务“体验对齐”，内部实现保持纯函数、无宿主依赖。 */
export const searchHardwareIndex = (
	boards: Array<BoardIndexItem>,
	libraries: Array<LibraryIndexItem>,
	query: HardwareSearchQuery
) => {
	const keywords = toKeywords(query.filters?.keywords ?? query.query)
	const type = query.type ?? 'both'
	const maxResults = query.maxResults ?? 50
	const results = [
		...(type === 'boards' || type === 'both' ? searchBoards(boards, keywords, query.filters) : []),
		...(type === 'libraries' || type === 'both' ? searchLibraries(libraries, keywords, query.filters) : [])
	]

	return results.sort((left, right) => right.score - left.score).slice(0, maxResults)
}
