import { assignMissingTodoIds, buildTodoItem, formatTodoList, normalizeTodoStatus, parseTodosParam } from '../normalize'

import type { RawTodoInput, TodoItem, TodoOperationResult, TodoPriority } from '../types'

/**
 * 全量替换 Todo 列表
 * @param existingTodos - 现有 Todo 列表
 * @param rawTodos - 原始 todos 参数
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
 * @param existingTodos - 现有 Todo 列表
 * @param rawTodos - 原始 todos 参数
 * @param singleTodoFallback - 单项 Todo 回退参数
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
		.filter((todo: RawTodoInput) => String(todo.content || todo.title || '').trim())
		.map(
			(todo): TodoItem => ({
				id: nextId++,
				content: String(todo.content || todo.title || '').trim(),
				status: normalizeTodoStatus(todo.status),
				priority:
					todo.priority === 'high' || todo.priority === 'medium' || todo.priority === 'low'
						? (todo.priority as TodoPriority)
						: 'medium',
				tags: Array.isArray(todo.tags) ? todo.tags.filter((tag): tag is string => typeof tag === 'string') : [],
				estimatedHours: typeof todo.estimatedHours === 'number' ? todo.estimatedHours : undefined,
				createdAt: Date.now(),
				updatedAt: Date.now()
			})
		)

	const updatedTodos = [...existingTodos, ...newTodos]
	return {
		ok: true,
		message: `添加了 ${newTodos.length} 个任务\n\n${formatTodoList(updatedTodos)}`,
		todos: updatedTodos
	}
}
