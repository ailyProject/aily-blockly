const ANSI_PATTERN = /\u001b\[\d+(;\d+)*m/g
const RAW_ANSI_PATTERN = /\[\d+(;\d+)*m/g

/**
 * 清除 ANSI 转义码和构建器标签
 * @param text - 原始输出文本
 */
export const stripBuildOutputDecorators = (text: string) =>
	text
		.replace(ANSI_PATTERN, '')
		.replace(RAW_ANSI_PATTERN, '')
		.replace(/\[ERROR\]\s*/gi, '')
		.replace(/\[WARNING\]\s*/gi, '')

/**
 * 将绝对路径缩短为 sketch 相对路径
 * @param line - 单行输出
 */
export const shortenBuildPath = (line: string) => line.replace(/[A-Za-z]:[\\/].*?[\\/]\.temp[\\/]sketch[\\/]/g, '')
