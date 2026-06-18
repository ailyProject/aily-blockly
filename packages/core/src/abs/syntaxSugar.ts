import { stripQuotes } from './strings'

import type { AbsSyntaxSugarResult } from './types'

const ABS_SYNTAX_SUGAR: Record<string, (args: Array<string>) => AbsSyntaxSugarResult> = {
	var: args => ({
		type: 'variables_get',
		fields: { VAR: { name: args[0] } }
	}),
	text: args => ({
		type: 'text',
		fields: { TEXT: stripQuotes(args[0] || '') }
	}),
	number: args => ({
		type: 'math_number',
		fields: { NUM: args[0] || '0' }
	}),
	HIGH: () => ({
		type: 'math_number',
		fields: { NUM: '1' }
	}),
	LOW: () => ({
		type: 'math_number',
		fields: { NUM: '0' }
	}),
	true: () => ({
		type: 'logic_boolean',
		fields: { BOOL: 'TRUE' }
	}),
	false: () => ({
		type: 'logic_boolean',
		fields: { BOOL: 'FALSE' }
	})
}

/**
 * 判断名称是否命中 ABS 语法糖
 * @param name - 语法糖名称
 */
export const isAbsSyntaxSugar = (name: string) => name in ABS_SYNTAX_SUGAR

/**
 * 解析 ABS 语法糖
 * @param name - 语法糖名称
 * @param args - 语法糖参数
 */
export const resolveAbsSyntaxSugar = (name: string, args: Array<string>): AbsSyntaxSugarResult | null => {
	const handler = ABS_SYNTAX_SUGAR[name]
	return handler ? handler(args) : null
}
