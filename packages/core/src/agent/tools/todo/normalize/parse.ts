import type { RawTodoInput } from '../types'

/**
 * 解析 todos 参数
 * @param raw - 原始参数
 */
export const parseTodosParam = (raw: unknown): Array<RawTodoInput> | string => {
	if (typeof raw === 'string') {
		try {
			return JSON.parse(raw)
		} catch {
			return 'todos 参数不是有效的 JSON 格式'
		}
	}

	return raw as Array<RawTodoInput>
}
