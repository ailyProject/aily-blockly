/**
 * 反转义字符串中的转义序列
 * @param value - 待处理字符串
 */
export const unescapeAbsString = (value: string): string =>
	value.replace(/\\(n|r|t|"|'|\\)/g, (match, char) => {
		switch (char) {
			case 'n':
				return '\n'
			case 'r':
				return '\r'
			case 't':
				return '\t'
			case '"':
				return '"'
			case "'":
				return "'"
			case '\\':
				return '\\'
			default:
				return match
		}
	})

/**
 * 去掉字符串两端的引号
 * @param value - 原始字符串
 */
export const stripQuotes = (value: string): string => {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1)
	}

	return value
}

/**
 * 判断值是否可视为标识符
 * @param value - 待检查文本
 */
export const isAbsIdentifier = (value: string) => /^[A-Z_][A-Z0-9_]*$/.test(value)

/**
 * 转义 ABS 字符串
 * @param value - 原始字符串
 */
export const escapeAbsString = (value: string) =>
	value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/"/g, '\\"')
