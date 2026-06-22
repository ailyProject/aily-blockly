/**
 * 将命令模板字符串拆成参数数组。
 * @param value - 原始命令模板
 */
export const parseHardwareUploadCommandArgs = (value: string) => {
	const args: Array<string> = []
	let current = ''
	let inQuote = false
	for (const char of value) {
		if (char === '"') {
			inQuote = !inQuote
			current += char
			continue
		}
		if (char === ' ' && !inQuote) {
			if (current) args.push(current)
			current = ''
			continue
		}
		current += char
	}
	if (current) args.push(current)
	return args.map(item => item.replace(/^"(.*)"$/s, '$1'))
}

/**
 * 展开上传模板中的 `{key}` 占位符。
 * @param pattern - 原始模板
 * @param resolver - 占位符解析函数
 * @param maxDepth - 最大展开轮数
 */
export const renderHardwareUploadPatternTemplate = (
	pattern: string,
	resolver: (key: string) => string | undefined,
	maxDepth = 8
) => {
	let current = pattern
	for (let depth = 0; depth < maxDepth; depth += 1) {
		let changed = false
		current = current.replace(/\{([^{}]+)\}/g, (match, key) => {
			const replacement = resolver(String(key).trim())
			if (!replacement) return match
			changed = true
			return replacement
		})
		if (!changed) break
	}
	return current
}
