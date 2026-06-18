import {
	assignMissingTodoIds,
	buildTodoItem,
	formatTodoList,
	normalizeTodoStatus,
	parseTodosParam,
	summarizeTodos
} from './normalize'

import type { TodoItem, TodoOperationResult, TodoStatistics } from './types'

/**
 * 全量替换 Todo 列表
 * @param {TodoItem[]} existingTodos - 现有 Todo 列表
 * @param {unknown} rawTodos - 原始 todos 参数
 * @returns {TodoOperationResult}
 */
export const updateTodos = (existingTodos: Array<TodoItem>, rawTodos: unknown): TodoOperationResult => {
	const todosArray = parseTodosParam(rawTodos)
	if (typeof todosArray === 'string') {
		return { ok: false, message: todosArray }
	}
	if (!Array.isArray(todosArray) || todosArray.length === 0) {
		return { ok: false, message: 'update 需要一个非空的 todos 数组（全量替换）' }
	}

	const existingByContent = new Map<string, TodoItem>()
	for (const todo of existingTodos) {
		existingByContent.set(todo.content.toLowerCase(), todo)
	}
	const usedIds = new Set<number>()
	const nextTodos = todosArray.map(todo => buildTodoItem(todo, existingByContent, usedIds))
	assignMissingTodoIds(nextTodos, existingTodos)

	return {
		ok: true,
		message: `TODO列表已替换（${nextTodos.length} 项）\n\n${formatTodoList(nextTodos)}`,
		todos: nextTodos
	}
}

/**
 * 追加 Todo 列表
 * @param {TodoItem[]} existingTodos - 现有 Todo 列表
 * @param {unknown} rawTodos - 原始 todos 参数
 * @param {Record<string, unknown> | undefined} singleTodoFallback - 单项 Todo 回退参数
 * @returns {TodoOperationResult}
 */
export const addTodos = (
	existingTodos: Array<TodoItem>,
	rawTodos: unknown,
	singleTodoFallback?: Record<string, unknown>
): TodoOperationResult => {
	let todosArray = parseTodosParam(rawTodos)
	if (typeof todosArray === 'string') {
		return { ok: false, message: todosArray }
	}

	if (!todosArray) {
		const content = String(singleTodoFallback?.['content'] || singleTodoFallback?.['title'] || '').trim()
		if (!content) {
			return { ok: false, message: 'add 需要 content 或 todos 数组' }
		}
		todosArray = [
			{
				content,
				status: singleTodoFallback?.['status'],
				priority: singleTodoFallback?.['priority'],
				tags: singleTodoFallback?.['tags'],
				estimatedHours: singleTodoFallback?.['estimatedHours']
			}
		]
	}

	if (!Array.isArray(todosArray) || todosArray.length === 0) {
		return { ok: false, message: 'todos 必须是一个非空数组' }
	}

	let nextId = existingTodos.length > 0 ? Math.max(...existingTodos.map(todo => todo.id)) + 1 : 1
	const newTodos = todosArray
		.filter(todo => String(todo.content || todo.title || '').trim())
		.map(todo => ({
			id: nextId++,
			content: String(todo.content || todo.title || '').trim(),
			status: normalizeTodoStatus(todo.status),
			priority:
				todo.priority === 'high' || todo.priority === 'medium' || todo.priority === 'low' ? todo.priority : 'medium',
			tags: Array.isArray(todo.tags) ? todo.tags : [],
			estimatedHours: typeof todo.estimatedHours === 'number' ? todo.estimatedHours : undefined,
			createdAt: Date.now(),
			updatedAt: Date.now()
		}))

	const updatedTodos = [...existingTodos, ...newTodos]
	return {
		ok: true,
		message: `添加了 ${newTodos.length} 个任务\n\n${formatTodoList(updatedTodos)}`,
		todos: updatedTodos
	}
}

/**
 * 切换 Todo 状态
 * @param {TodoItem[]} todos - 当前 Todo 列表
 * @param {number} id - Todo ID
 * @returns {TodoOperationResult}
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
 * @param {TodoItem[]} todos - 当前 Todo 列表
 * @param {number} id - Todo ID
 * @returns {TodoOperationResult}
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
 * @param {TodoItem[]} todos - 当前 Todo 列表
 * @returns {TodoOperationResult}
 */
export const clearTodoList = (todos: Array<TodoItem>): TodoOperationResult => ({
	ok: true,
	message: `清空完成: 删除了 ${todos.length} 个任务`,
	todos: []
})

/**
 * 获取 Todo 统计
 * @param {TodoItem[]} todos - 当前 Todo 列表
 * @returns {TodoOperationResult}
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
