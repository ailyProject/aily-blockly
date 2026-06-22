import type { TodoItem, TodoPriority, TodoStatus } from '../types'

/**
 * 统计 Todo 列表
 * @param todos - Todo 列表
 */
export const summarizeTodos = (todos: Array<TodoItem>) => {
	const byStatus: Record<TodoStatus, number> = {
		'not-started': 0,
		'in-progress': 0,
		completed: 0
	}
	const byPriority: Record<TodoPriority, number> = {
		high: 0,
		medium: 0,
		low: 0
	}
	let estimatedTotalHours = 0

	for (const todo of todos) {
		byStatus[todo.status] += 1
		byPriority[todo.priority] += 1
		estimatedTotalHours += todo.estimatedHours || 0
	}

	return {
		total: todos.length,
		byStatus,
		byPriority,
		estimatedTotalHours
	}
}
