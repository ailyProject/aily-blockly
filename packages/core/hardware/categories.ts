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

/**
 * 统计开发板分类分布
 * @param {BoardIndexItem[]} boards - 开发板索引列表
 * @param {BoardCategoryDimension} dimension - 分类维度
 * @returns {HardwareCategoryResult}
 */
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

/**
 * 统计库分类分布
 * @param {LibraryIndexItem[]} libraries - 库索引列表
 * @param {LibraryCategoryDimension} dimension - 分类维度
 * @returns {HardwareCategoryResult}
 */
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
