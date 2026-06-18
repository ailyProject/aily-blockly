type FfsTreeEntry = {
	path?: unknown
	type?: unknown
}

/**
 * 以深度优先方式遍历底层文件系统客户端返回的目录树。
 * @param options - 遍历参数
 */
export const collectFfsTreeEntries = <TEntry extends FfsTreeEntry>(options: {
	rootPaths: Array<string>
	list: (path: string) => Array<TEntry>
}) => {
	const entries: Array<TEntry> = []
	const stack = [...options.rootPaths]

	while (stack.length > 0) {
		const currentPath = stack.pop() || '/'
		for (const entry of options.list(currentPath)) {
			entries.push(entry)
			if (entry.type === 'dir' && typeof entry.path === 'string') {
				stack.push(entry.path)
			}
		}
	}

	return entries
}
