import { formatTodoList } from '../normalize'

import type { TodoItem, TodoOperationResult } from '../types'

/**
 * 切换 Todo 状态
 * @param todos - 当前 Todo 列表
 * @param id - Todo ID
 */
export const toggleTodo = (todos: Array<TodoItem>, id: number): TodoOperationResult => {
	if (Number.isNaN(id)) {
		return { ok: false, message: '缺少有效的任务 ID (数字)' }
	}

	const todo = todos.find(item => item.id === id)
	if (!todo) {
		return { ok: false, message: `找不到 ID 为 ${id} 的任务。当前任务IDs: ${todos.map(item => item.id).join(', ')}` }
	}

	const statusCycle: Record<TodoItem['status'], TodoItem['status']> = {
		'not-started': 'in-progress',
		'in-progress': 'completed',
		completed: 'not-started'
	}
	const nextStatus = statusCycle[todo.status]

	if (nextStatus === 'in-progress' && todos.some(item => item.id !== id && item.status === 'in-progress')) {
		return { ok: false, message: '已有其他任务在进行中' }
	}

	const nextTodos = todos.map(item =>
		item.id === id
			? {
					...item,
					status: nextStatus,
					updatedAt: Date.now()
				}
			: item
	)

	return {
		ok: true,
		message: `任务 ${id} 状态更新: ${nextStatus}\n\n${formatTodoList(nextTodos)}`,
		todos: nextTodos
	}
}

/**
 * 删除 Todo
 * @param todos - 当前 Todo 列表
 * @param id - Todo ID
 */
export const deleteTodo = (todos: Array<TodoItem>, id: number): TodoOperationResult => {
	if (Number.isNaN(id)) {
		return { ok: false, message: '缺少有效的任务 ID (数字)' }
	}

	const index = todos.findIndex(item => item.id === id)
	if (index === -1) {
		return { ok: false, message: `找不到 ID 为 ${id} 的任务。当前任务IDs: ${todos.map(item => item.id).join(', ')}` }
	}

	const nextTodos = [...todos]
	const removed = nextTodos.splice(index, 1)[0]

	return {
		ok: true,
		message: `任务删除成功: ${removed.content}\n\n${formatTodoList(nextTodos)}`,
		todos: nextTodos
	}
}

/**
 * 清空 Todo 列表
 * @param todos - 当前 Todo 列表
 */
export const clearTodoList = (todos: Array<TodoItem>): TodoOperationResult => ({
	ok: true,
	message: `清空完成: 删除了 ${todos.length} 个任务`,
	todos: []
})
