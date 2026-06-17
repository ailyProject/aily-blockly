import type { TodoItem, TodoPriority, TodoStatus } from './types'

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
 * @param {string | undefined} status - 原始状态值
 * @returns {TodoStatus}
 */
export const normalizeTodoStatus = (status: string | undefined): TodoStatus => {
	if (!status) return 'not-started'
	return STATUS_ALIASES[status.toLowerCase()] || 'not-started'
}

const normalizeTodoPriority = (priority: unknown): TodoPriority =>
	priority === 'high' || priority === 'medium' || priority === 'low' ? priority : 'medium'

/**
 * 解析 todos 参数
 * @param {unknown} raw - 原始参数
 * @returns {any[] | string}
 */
export const parseTodosParam = (raw: unknown): Array<any> | string => {
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw)
		} catch {
			return 'todos 参数不是有效的 JSON 格式'
		}
	}

	return raw as Array<any>
}

/**
 * 格式化 Todo 列表
 * @param {TodoItem[]} todos - Todo 列表
 * @returns {string}
 */
export const formatTodoList = (todos: Array<TodoItem>) => {
	if (todos.length === 0) return 'TODO列表为空'

	let result = '# TODO列表\n\n| ID | 状态 | 优先级 | 内容 |\n| --- | --- | --- | --- |\n'
	for (const todo of todos) {
		result += `| ${todo.id} | ${todo.status} | ${todo.priority.toUpperCase()} | ${todo.content} |\n`
	}

	return result.trim()
}

/**
 * 基于 content 复用 ID 构建 Todo 项
 * @param {any} todo - 原始 todo
 * @param {Map<string, TodoItem>} existingByContent - 现有任务索引
 * @param {Set<number>} usedIds - 已占用 ID 集合
 * @returns {TodoItem}
 */
export const buildTodoItem = (todo: any, existingByContent: Map<string, TodoItem>, usedIds: Set<number>): TodoItem => {
	const content = String(todo.content || todo.title || '').trim()
	const hasId = typeof todo.id === 'number'
	let resolvedId: number
	let createdAt = todo.createdAt || Date.now()

	if (hasId) {
		resolvedId = todo.id
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
 * @param {TodoItem[]} todos - 待分配 Todo 列表
 * @param {TodoItem[]} existingTodos - 现有 Todo 列表
 * @returns {TodoItem[]}
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

/**
 * 统计 Todo 列表
 * @param {TodoItem[]} todos - Todo 列表
 * @returns {{ total: number; byStatus: Record<TodoStatus, number>; byPriority: Record<TodoPriority, number>; estimatedTotalHours: number }}
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
