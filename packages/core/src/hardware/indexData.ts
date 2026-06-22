import { buildBoardIndexCacheEnvelope, buildItemDictionary, buildLibraryIndexCacheEnvelope } from './indexData/build'
import { parseArrayPayload } from './indexData/parse'

import type {
	BoardIndexItem,
	HardwareIndexCacheEnvelope,
	HardwareTagList,
	LegacyBoardItem,
	LegacyLibraryItem,
	LibraryIndexItem
} from './types'

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

export { buildBoardIndexCacheEnvelope, buildItemDictionary, buildLibraryIndexCacheEnvelope, parseArrayPayload }
