import type { BoardIndexItem, HardwareIndexCacheEnvelope, LibraryIndexItem } from '../types'

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
