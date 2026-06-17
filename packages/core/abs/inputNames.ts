const ABS_INPUT_NAME_MAPPING: Record<string, string> = {
	DO0: 'do',
	DO: 'do',
	ELSE: 'else',
	DEFAULT: 'default',
	IF0: 'condition',
	HANDLER: 'handler',
	ARDUINO_SETUP: 'setup',
	ARDUINO_LOOP: 'loop'
}

/**
 * 判断输入名是否可能是语句输入
 * @param inputName - 输入名称
 */
export const isLikelyStatementInput = (inputName: string): boolean => {
	const patterns = [
		/^DO\d*$/,
		/^ELSE$/,
		/^DEFAULT$/,
		/^HANDLER$/,
		/^STACK$/,
		/^SUBSTACK\d*$/,
		/STATEMENT/i,
		/^ARDUINO_/
	]

	return patterns.some(pattern => pattern.test(inputName))
}

/**
 * 规范化输入名用于 ABS 展示
 * @param inputName - 原始输入名
 */
export const normalizeInputNameForAbs = (inputName: string): string => {
	if (ABS_INPUT_NAME_MAPPING[inputName]) {
		return ABS_INPUT_NAME_MAPPING[inputName]
	}

	const doMatch = inputName.match(/^DO(\d+)$/)
	if (doMatch) {
		const index = Number.parseInt(doMatch[1], 10)
		return index === 0 ? 'do' : `do${index}`
	}

	const caseMatch = inputName.match(/^CASE(\d+)$/)
	if (caseMatch) {
		return `case${caseMatch[1]}`
	}

	return inputName.toLowerCase()
}
