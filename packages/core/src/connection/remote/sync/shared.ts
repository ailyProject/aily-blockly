/**
 * 读取当前依赖目录下可参与远端同步的本地包列表。
 * @param ailyRoot - `@aily-project` 根目录
 */
export const readRemoteLocalPackageDirs = async (ailyRoot: string) => {
	const fs = await import('node:fs')
	if (!fs.existsSync(ailyRoot)) return []

	return fs
		.readdirSync(ailyRoot)
		.filter(
			name => (name.startsWith('lib-') || name.startsWith('board-')) && fs.statSync(`${ailyRoot}/${name}`).isDirectory()
		)
}

/**
 * 创建云端 pinmap 同步请求头。
 * @param input - 外部 headers 与可选 auth token
 */
export const createRemoteSyncHeaders = (input: { headers?: Record<string, string>; authToken?: string }) => {
	const localHeaders: Record<string, string> = {
		Accept: 'application/json',
		...(input.headers || {})
	}
	if (input.authToken && !localHeaders['Authorization'] && !localHeaders['authorization']) {
		localHeaders['Authorization'] = `Bearer ${input.authToken}`
	}
	return localHeaders
}
