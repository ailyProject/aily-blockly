import { normalizeTodoPriority, normalizeTodoStatus } from './status'

import type { RawTodoInput, TodoItem } from '../types'

/**
 * 基于 content 复用 ID 构建 Todo 项
 * @param todo - 原始 todo
 * @param existingByContent - 现有任务索引
 * @param usedIds - 已占用 ID 集合
 */
export const buildTodoItem = (
	todo: RawTodoInput,
	existingByContent: Map<string, TodoItem>,
	usedIds: Set<number>
): TodoItem => {
	const content = String(todo.content || todo.title || '').trim()
	const hasId = typeof todo.id === 'number'
	let resolvedId: number
	let createdAt = typeof todo.createdAt === 'number' ? todo.createdAt : Date.now()

	if (hasId) {
		resolvedId = todo.id!
	} else {
		const matched = existingByContent.get(content.toLowerCase())
		if (matched && !usedIds.has(matched.id)) {
			resolvedId = matched.id
			createdAt = matched.createdAt || createdAt
		} else {
			resolvedId = -1
		}
	}

	usedIds.add(resolvedId)

	return {
		id: resolvedId,
		content,
		status: normalizeTodoStatus(todo.status),
		priority: normalizeTodoPriority(todo.priority),
		tags: Array.isArray(todo.tags) ? todo.tags : [],
		estimatedHours: typeof todo.estimatedHours === 'number' ? todo.estimatedHours : undefined,
		createdAt,
		updatedAt: Date.now()
	}
}

/**
 * 为缺失 ID 的 Todo 分配新 ID
 * @param todos - 待分配 Todo 列表
 * @param existingTodos - 现有 Todo 列表
 */
export const assignMissingTodoIds = (todos: Array<TodoItem>, existingTodos: Array<TodoItem>) => {
	const allKnownIds = new Set([
		...existingTodos.map(item => item.id),
		...todos.filter(item => item.id > 0).map(item => item.id)
	])
	let nextId = allKnownIds.size > 0 ? Math.max(...allKnownIds) + 1 : 1

	for (const todo of todos) {
		if (todo.id === -1) {
			todo.id = nextId++
		}
	}

	return todos
}
