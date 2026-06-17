import type { RecentlyProjectEntry } from './types'

/**
 * 按路径去重并把最近访问的项目提升到最前，同时控制列表长度
 * @param {RecentlyProjectEntry[]} current - 当前最近项目列表
 * @param {RecentlyProjectEntry} entry - 新进入列表的项目
 * @param {number} maxSize - 最大保留数量
 * @returns {RecentlyProjectEntry[]}
 */
export const addRecentlyProject = (
	current: Array<RecentlyProjectEntry>,
	entry: RecentlyProjectEntry,
	maxSize = 6
): Array<RecentlyProjectEntry> => {
	const next = [entry, ...current].filter(
		(item, index, list) => list.findIndex(candidate => candidate.path === item.path) === index
	)

	return next.slice(0, maxSize)
}

/**
 * 从最近项目列表中移除指定路径对应的条目
 * @param {RecentlyProjectEntry[]} current - 当前最近项目列表
 * @param {string} path - 要移除的项目路径
 * @returns {RecentlyProjectEntry[]}
 */
export const removeRecentlyProject = (current: Array<RecentlyProjectEntry>, path: string) =>
	current.filter(item => item.path !== path)
