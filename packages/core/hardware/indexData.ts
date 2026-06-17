import type { BoardIndexItem, HardwareTagList, LegacyBoardItem, LegacyLibraryItem, LibraryIndexItem } from './types'

/**
 * 解析旧格式开发板列表
 * @param {string} raw - 原始 JSON 文本
 * @returns {LegacyBoardItem[]}
 */
export const parseLegacyBoardList = (raw: string): Array<LegacyBoardItem> => {
	const parsed = JSON.parse(raw)
	return Array.isArray(parsed) ? parsed : []
}

/**
 * 解析旧格式库列表
 * @param {string} raw - 原始 JSON 文本
 * @returns {LegacyLibraryItem[]}
 */
export const parseLegacyLibraryList = (raw: string): Array<LegacyLibraryItem> => {
	const parsed = JSON.parse(raw)
	return Array.isArray(parsed) ? parsed : []
}

/**
 * 解析新格式开发板索引
 * @param {string} raw - 原始 JSON 文本
 * @returns {BoardIndexItem[]}
 */
export const parseBoardIndex = (raw: string): Array<BoardIndexItem> => {
	const parsed = JSON.parse(raw)
	return Array.isArray(parsed) ? parsed : []
}

/**
 * 解析新格式库索引
 * @param {string} raw - 原始 JSON 文本
 * @returns {LibraryIndexItem[]}
 */
export const parseLibraryIndex = (raw: string): Array<LibraryIndexItem> => {
	const parsed = JSON.parse(raw)
	return Array.isArray(parsed) ? parsed : []
}

/**
 * 解析标签列表
 * @param {string} raw - 原始 JSON 文本
 * @returns {HardwareTagList}
 */
export const parseHardwareTagList = (raw: string): HardwareTagList => {
	const parsed = JSON.parse(raw)
	return parsed && typeof parsed === 'object' ? parsed : {}
}

/**
 * 为列表构建 name -> item 字典
 * @param {Array<{ name: string }>} items - 列表项
 * @returns {Record<string, T>}
 */
export const buildItemDictionary = <T extends { name: string }>(items: Array<T>) =>
	items.reduce<Record<string, T>>((result, item) => {
		result[item.name] = item
		return result
	}, {})
