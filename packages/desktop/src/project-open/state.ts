let pendingProjectOpenPath = ''

/**
 * 写入待打开项目路径。
 * @param projectPath - 待打开路径
 */
export const queueDesktopPendingProjectOpenPath = (projectPath: string) => {
	pendingProjectOpenPath = String(projectPath || '').trim()
}

/**
 * 读取并消费待打开项目路径。
 */
export const consumeDesktopPendingProjectOpenPath = () => {
	const projectPath = pendingProjectOpenPath
	pendingProjectOpenPath = ''
	return projectPath
}

/**
 * 只读查看待打开项目路径。
 */
export const peekDesktopPendingProjectOpenPath = () => pendingProjectOpenPath
