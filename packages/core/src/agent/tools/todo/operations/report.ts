import { summarizeTodos } from '../normalize'

import type { TodoItem, TodoOperationResult, TodoStatistics } from '../types'

/**
 * 获取 Todo 统计
 * @param todos - 当前 Todo 列表
 */
export const getTodoStatisticsResult = (todos: Array<TodoItem>): TodoOperationResult => {
	const statistics: TodoStatistics = summarizeTodos(todos)
	return {
		ok: true,
		message:
			`统计\n\n` +
			`总数: ${statistics.total} | 待处理: ${statistics.byStatus['not-started']} | ` +
			`进行中: ${statistics.byStatus['in-progress']} | 已完成: ${statistics.byStatus.completed}\n` +
			`高: ${statistics.byPriority.high} | 中: ${statistics.byPriority.medium} | 低: ${statistics.byPriority.low}\n` +
			`预估总工时: ${statistics.estimatedTotalHours}h`,
		statistics
	}
}
