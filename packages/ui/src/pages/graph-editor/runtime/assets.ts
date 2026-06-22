import type { Core } from '@/utils/core'

/**
 * 加载当前工程的连线资产状态。
 * @param core - core 服务句柄
 */
export const loadGraphEditorWorkspaceState = (core: Core, projectPath: string) =>
	projectPath ? core.connection.getWorkspaceState.query({ projectPath }) : Promise.resolve(null)

/**
 * 读取当前工程的 graph/aws 文本内容。
 * @param core - core 服务句柄
 * @param projectPath - 当前项目路径
 */
export const loadGraphEditorAssets = async (core: Core, projectPath: string) => {
	if (!projectPath) {
		return {
			graphJson: '',
			awsContent: ''
		}
	}

	const [graph, awsContent] = await Promise.all([
		core.connection.readGraph.query({ projectPath }),
		core.connection.readAws.query({ projectPath })
	])

	return {
		graphJson: graph ? JSON.stringify(graph, null, 2) : '',
		awsContent: awsContent ?? ''
	}
}

/**
 * 从 graph JSON 文本中提取 pinmapId 提示列表。
 * @param raw - graph JSON 文本
 */
export const extractGraphEditorPinmapHints = (raw: string) => {
	try {
		if (!raw.trim()) return []
		const parsed = JSON.parse(raw) as { components?: Array<{ pinmapId?: unknown }> }
		return Array.from(
			new Set(
				(parsed.components ?? [])
					.map(component => (typeof component.pinmapId === 'string' ? component.pinmapId.trim() : ''))
					.filter(Boolean)
			)
		)
	} catch {
		return []
	}
}
