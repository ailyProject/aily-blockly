/**
 * 获取字符串的 bigram 集合。
 * @param value - 输入字符串
 */
export const getBigrams = (value: string) => {
	const bigrams = new Set<string>()

	for (let index = 0; index < value.length - 1; index += 1) {
		bigrams.add(value.substring(index, index + 2))
	}

	return bigrams
}

/**
 * 计算两个字符串的近似相似度。
 * @param left - 左侧字符串
 * @param right - 右侧字符串
 */
export const calculateSimilarity = (left: string, right: string): number => {
	if (!left || !right) return 0
	if (left === right) return 1

	if (left.includes(right) || right.includes(left)) {
		const shorter = left.length < right.length ? left : right
		const longer = left.length < right.length ? right : left
		return (shorter.length / longer.length) * 0.8 + 0.2
	}

	if (left.length < 2 || right.length < 2) {
		return 0
	}

	const leftBigrams = getBigrams(left)
	const rightBigrams = getBigrams(right)
	let intersection = 0

	for (const bigram of leftBigrams) {
		if (rightBigrams.has(bigram)) {
			intersection += 1
		}
	}

	return (2 * intersection) / (leftBigrams.size + rightBigrams.size)
}

/**
 * 从查询文本中提取可用于匹配的关键词。
 * @param query - 原始查询文本
 */
export const extractKeywords = (query: string): Array<string> => {
	if (!query) return []

	const cleaned = query
		.replace(/@aily-project\//gi, '')
		.replace(/^lib-/gi, '')
		.replace(/\s+/g, ' ')
		.trim()

	return [
		...new Set(
			cleaned
				.split(/[-_\s/]+/)
				.filter(keyword => keyword.length >= 2)
				.map(keyword => keyword.toLowerCase())
		)
	]
}
