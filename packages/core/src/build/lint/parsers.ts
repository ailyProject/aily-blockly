/**
 * 根据字符位置计算行号和列号
 * @param content - 文本内容
 * @param position - 字符位置
 */
export const getLineAndColumn = (content: string, position: number) => {
	const lines = content.substring(0, position).split('\n')
	return {
		line: lines.length,
		column: (lines[lines.length - 1] || '').length + 1
	}
}

/**
 * 解析 JSON 错误
 * @param errorMessage - 错误消息
 * @param content - 文件内容
 */
export const parseJsonError = (errorMessage: string, content: string) => {
	let line = 1
	let column = 1
	const message = errorMessage

	const positionMatch = errorMessage.match(/at position (\d+)/i)
	if (positionMatch) {
		const position = Number.parseInt(positionMatch[1], 10)
		const loc = getLineAndColumn(content, position)
		line = loc.line
		column = loc.column
	}

	if (errorMessage.includes('Unexpected end')) {
		const lines = content.split('\n')
		line = lines.length
		column = (lines[lines.length - 1] || '').length + 1
	}

	return { line, column, message }
}

/**
 * 解析 JavaScript 语法错误
 * @param error - 语法错误对象
 */
export const parseJavaScriptError = (error: Error) => {
	let line = 1
	let column = 1
	const message = error.message || 'JavaScript syntax error'

	if (error.stack) {
		const stackMatch = error.stack.match(/<anonymous>:(\d+):(\d+)/)
		if (stackMatch) {
			line = Math.max(1, Number.parseInt(stackMatch[1], 10) - 2)
			column = Number.parseInt(stackMatch[2], 10)
		}
	}

	const lineMatch = message.match(/line (\d+)/i)
	if (lineMatch) {
		line = Number.parseInt(lineMatch[1], 10)
	}

	return { line, column, message }
}
