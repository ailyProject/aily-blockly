const quoteShellSegment = (value: string) => {
	if (!value.length) return '""'
	return /[\s"'`$\\]/.test(value) ? JSON.stringify(value) : value
}

/**
 * 把命令和参数渲染为可读的命令预览。
 * @param executable - 可执行程序
 * @param args - 参数列表
 */
export const formatTerminalCommandPreview = (executable: string, args: Array<string>) =>
	[executable, ...args].map(segment => quoteShellSegment(segment)).join(' ')
