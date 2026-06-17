import type {
	BoardCategoryDimension,
	BoardIndexItem,
	CategoryCount,
	HardwareCategoryResult,
	LibraryCategoryDimension,
	LibraryIndexItem
} from './types'

const countValues = (values: Array<string>) => {
	const counter = new Map<string, number>()
	for (const value of values.filter(Boolean)) {
		counter.set(value, (counter.get(value) ?? 0) + 1)
	}

	return [...counter.entries()]
		.map<CategoryCount>(([name, count]) => ({ name, count }))
		.sort((left, right) => right.count - left.count)
}

/** 中文注释：统计开发板分类分布，供引导式选型和结构化筛选面板复用。 */
export const getBoardCategories = (
	boards: Array<BoardIndexItem>,
	dimension: BoardCategoryDimension
): HardwareCategoryResult => {
	const values = boards.flatMap(board => {
		switch (dimension) {
			case 'brand':
				return [board.brand]
			case 'architecture':
				return [board.architecture]
			case 'connectivity':
				return board.connectivity
			case 'interfaces':
				return board.interfaces
			case 'tags':
				return board.tags
		}
	})

	return {
		type: 'boards',
		dimension,
		total: boards.length,
		categories: countValues(values)
	}
}

/** 中文注释：统计库分类分布，让 agent 先看分类，再做精确搜索。 */
export const getLibraryCategories = (
	libraries: Array<LibraryIndexItem>,
	dimension: LibraryCategoryDimension
): HardwareCategoryResult => {
	const values = libraries.flatMap(library => {
		switch (dimension) {
			case 'category':
				return [library.category]
			case 'hardwareType':
				return library.hardwareType
			case 'communication':
				return library.communication
			case 'supportedCores':
				return library.supportedCores
		}
	})

	return {
		type: 'libraries',
		dimension,
		total: libraries.length,
		categories: countValues(values)
	}
}
