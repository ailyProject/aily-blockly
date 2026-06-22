import type { TodoPriority, TodoStatus } from '../types'

const STATUS_ALIASES: Record<string, TodoStatus> = {
	'not-started': 'not-started',
	'in-progress': 'in-progress',
	completed: 'completed',
	pending: 'not-started',
	in_progress: 'in-progress',
	todo: 'not-started',
	done: 'completed'
}

/**
 * 规范化 Todo 状态
 * @param status - 原始状态值
 */
export const normalizeTodoStatus = (status: unknown): TodoStatus => {
	if (typeof status !== 'string' || !status.trim()) return 'not-started'
	return STATUS_ALIASES[status.toLowerCase()] || 'not-started'
}

/**
 * 规范化 Todo 优先级。
 * @param priority - 原始优先级
 */
export const normalizeTodoPriority = (priority: unknown): TodoPriority =>
	priority === 'high' || priority === 'medium' || priority === 'low' ? priority : 'medium'
