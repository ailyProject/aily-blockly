import type { TodoItem } from '../types'

/**
 * 格式化 Todo 列表
 * @param todos - Todo 列表
 */
export const formatTodoList = (todos: Array<TodoItem>) => {
	if (todos.length === 0) return 'TODO列表为空'

	let result = '# TODO列表\n\n| ID | 状态 | 优先级 | 内容 |\n| --- | --- | --- | --- |\n'
	for (const todo of todos) {
		result += `| ${todo.id} | ${todo.status} | ${todo.priority.toUpperCase()} | ${todo.content} |\n`
	}

	return result.trim()
}
