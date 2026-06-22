import { includesAll, scoreText } from '../common'

import type { HardwareSearchFilters, HardwareSearchResult, LibraryIndexItem } from '../../types'

/**
 * 执行结构化库搜索。
 * @param libraries - 库索引列表
 * @param keywords - 关键词列表
 * @param filters - 过滤条件
 */
export const searchHardwareLibraries = (
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
				for (const [field, value] of contributions) if (value > 0) matchedFields.add(field)
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
