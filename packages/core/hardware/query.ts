import type {
	BoardIndexItem,
	HardwareSearchFilters,
	HardwareSearchQuery,
	HardwareSearchResult,
	LegacyBoardItem,
	LegacyLibraryItem,
	LibraryIndexItem
} from './types'

export const toKeywords = (input?: string | Array<string>) => {
	if (!input) return []
	if (Array.isArray(input)) return input.map(item => item.trim().toLowerCase()).filter(Boolean)

	return input
		.split(/[,，]/)
		.flatMap(part => part.trim().split(/\s+/))
		.map(item => item.trim().toLowerCase())
		.filter(Boolean)
}

export const compareNumeric = (value: number, condition?: string) => {
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

export const convertFiltersToQueries = (
	filters: HardwareSearchFilters | undefined,
	type: 'boards' | 'libraries'
): Array<string> => {
	if (!filters) return []

	const queries: Array<string> = []
	if (type === 'boards') {
		if (filters.architecture) {
			queries.push(filters.architecture.toLowerCase())
			if (filters.architecture.includes('xtensa')) queries.push('esp32')
			if (filters.architecture === 'avr') queries.push('arduino')
		}
		if (filters.connectivity) queries.push(...filters.connectivity.map(item => item.toLowerCase()))
		if (filters.interfaces) queries.push(...filters.interfaces.map(item => item.toLowerCase()))
		if (filters.brand) queries.push(filters.brand.toLowerCase())
		return queries
	}

	if (filters.category) queries.push(filters.category.toLowerCase())
	if (filters.hardwareType) queries.push(...filters.hardwareType.map(item => item.toLowerCase()))
	if (filters.communication) queries.push(...filters.communication.map(item => item.toLowerCase()))
	if (filters.supportedCores) {
		for (const core of filters.supportedCores) {
			queries.push(...core.toLowerCase().split(':').filter(Boolean))
		}
	}

	return queries
}

const findLegacyDescription = <T extends { name: string; description?: string }>(name: string, oldData?: Array<T>) => {
	if (!oldData) return undefined
	const found = oldData.find(
		item => item.name === name || item.name === `@aily-project/${name}` || item.name.endsWith(`/${name}`)
	)
	return found?.description
}

/**
 * 对开发板执行结构化筛选与文本评分
 * @param boards - 开发板索引列表
 * @param keywords - 规范化后的搜索关键词
 * @param filters - 结构化筛选条件
 */
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

/**
 * 对库索引执行结构化筛选与文本评分
 * @param libraries - 库索引列表
 * @param keywords - 规范化后的搜索关键词
 * @param filters - 结构化筛选条件
 */
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
		...(type === 'boards' || type === 'both' ? searchBoards(boards, keywords, query.filters) : []),
		...(type === 'libraries' || type === 'both' ? searchLibraries(libraries, keywords, query.filters) : [])
	]

	return results.sort((left, right) => right.score - left.score).slice(0, maxResults)
}

export const searchHardwareIndexCompat = (
	boards: Array<BoardIndexItem>,
	libraries: Array<LibraryIndexItem>,
	query: HardwareSearchQuery,
	legacy?: { legacyBoards?: Array<LegacyBoardItem>; legacyLibraries?: Array<LegacyLibraryItem> }
) => {
	if (boards.length > 0 || libraries.length > 0) {
		return searchHardwareIndex(boards, libraries, query).map(result => ({
			...result,
			description:
				result.description ||
				(result.source === 'board'
					? findLegacyDescription(result.name, legacy?.legacyBoards)
					: findLegacyDescription(result.name, legacy?.legacyLibraries)) ||
				result.displayName
		}))
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
