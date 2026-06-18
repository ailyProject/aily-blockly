import type {
	BoardIndexItem,
	HardwareIndexCacheEnvelope,
	HardwareTagList,
	LegacyBoardItem,
	LegacyLibraryItem,
	LibraryIndexItem
} from './types'

/**
 * 解析数组载荷
 * @param raw - 原始 JSON 文本
 * @param invalidMessage - 无效时的错误消息
 * @param wrapperKey - 可选包裹字段
 */
export const parseArrayPayload = <T>(raw: string, invalidMessage: string, wrapperKey?: string): Array<T> => {
	const parsed = JSON.parse(raw)
	if (Array.isArray(parsed)) {
		return parsed
	}

	if (
		wrapperKey &&
		parsed &&
		typeof parsed === 'object' &&
		Array.isArray((parsed as Record<string, unknown>)[wrapperKey])
	) {
		return (parsed as Record<string, Array<T>>)[wrapperKey]
	}

	throw new Error(invalidMessage)
}

/**
 * 解析旧格式开发板列表
 * @param raw - 原始 JSON 文本
 */
export const parseLegacyBoardList = (raw: string): Array<LegacyBoardItem> => {
	return parseArrayPayload<LegacyBoardItem>(raw, 'boards.json 格式无效')
}

/**
 * 解析旧格式库列表
 * @param raw - 原始 JSON 文本
 */
export const parseLegacyLibraryList = (raw: string): Array<LegacyLibraryItem> => {
	return parseArrayPayload<LegacyLibraryItem>(raw, 'libraries.json 格式无效')
}

/**
 * 解析新格式开发板索引
 * @param raw - 原始 JSON 文本
 */
export const parseBoardIndex = (raw: string): Array<BoardIndexItem> => {
	return parseArrayPayload<BoardIndexItem>(raw, 'boards-index.json 格式无效', 'boards')
}

/**
 * 解析新格式库索引
 * @param raw - 原始 JSON 文本
 */
export const parseLibraryIndex = (raw: string): Array<LibraryIndexItem> => {
	return parseArrayPayload<LibraryIndexItem>(raw, 'libraries-index.json 格式无效', 'libraries')
}

/**
 * 解析标签列表
 * @param raw - 原始 JSON 文本
 */
export const parseHardwareTagList = (raw: string): HardwareTagList => {
	const parsed = JSON.parse(raw)
	return parsed && typeof parsed === 'object' ? parsed : {}
}

/**
 * 构建开发板索引缓存包装
 * @param boards - 开发板索引列表
 */
export const buildBoardIndexCacheEnvelope = (
	boards: Array<BoardIndexItem>
): HardwareIndexCacheEnvelope<BoardIndexItem, 'boards'> => ({
	version: '1.0.0',
	generated: new Date().toISOString(),
	count: boards.length,
	boards
})

/**
 * 构建库索引缓存包装
 * @param libraries - 库索引列表
 */
export const buildLibraryIndexCacheEnvelope = (
	libraries: Array<LibraryIndexItem>
): HardwareIndexCacheEnvelope<LibraryIndexItem, 'libraries'> => ({
	version: '1.0.0',
	generated: new Date().toISOString(),
	count: libraries.length,
	libraries
})

/**
 * 为列表构建 name -> item 字典
 * @param items - 列表项
 */
export const buildItemDictionary = <T extends { name: string }>(items: Array<T>) =>
	items.reduce<Record<string, T>>((result, item) => {
		result[item.name] = item
		return result
	}, {})
