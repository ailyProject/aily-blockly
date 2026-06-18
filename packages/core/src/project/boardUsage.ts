import type { BoardUsageCountMap } from './types'

/**
 * 增加指定开发板的使用次数。
 * @param usageCount - 当前使用次数映射
 * @param boardName - 开发板名称
 */
export const recordBoardUsage = (
	usageCount: BoardUsageCountMap | undefined,
	boardName: string
): BoardUsageCountMap => ({
	...(usageCount ?? {}),
	[boardName]: (usageCount?.[boardName] ?? 0) + 1
})

/**
 * 读取指定开发板的使用次数。
 * @param usageCount - 当前使用次数映射
 * @param boardName - 开发板名称
 */
export const getBoardUsageCount = (usageCount: BoardUsageCountMap | undefined, boardName: string) =>
	usageCount?.[boardName] ?? 0

/**
 * 返回完整的开发板使用次数映射。
 * @param usageCount - 当前使用次数映射
 */
export const getAllBoardUsageCount = (usageCount: BoardUsageCountMap | undefined): BoardUsageCountMap => ({
	...(usageCount ?? {})
})

/**
 * 按使用次数对开发板列表做稳定排序。
 * @param boardList - 待排序开发板列表
 * @param usageCount - 当前使用次数映射
 */
export const sortBoardsByUsage = <T extends { name: string }>(
	boardList: Array<T>,
	usageCount: BoardUsageCountMap | undefined
) =>
	[...boardList].sort((left, right) => {
		const leftUsage = usageCount?.[left.name] ?? 0
		const rightUsage = usageCount?.[right.name] ?? 0

		if (leftUsage !== rightUsage) {
			return rightUsage - leftUsage
		}

		return 0
	})
