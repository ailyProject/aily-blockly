import { getConnectionColor } from './colors'

import type { ConnectionGraphData } from './types'

/**
 * 解析连线图 JSON 字符串。
 * @param raw - 原始文本，支持 markdown code block
 */
export const parseConnectionGraphJson = (raw: string): ConnectionGraphData | null => {
	try {
		const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
		const jsonText = codeBlockMatch ? codeBlockMatch[1].trim() : raw.trim()
		const data = JSON.parse(jsonText) as ConnectionGraphData

		if (!data.version || !Array.isArray(data.components) || !Array.isArray(data.connections)) {
			return null
		}

		for (const connection of data.connections) {
			if (
				!connection.id ||
				!connection.from?.ref ||
				!connection.from?.pinId ||
				!connection.to?.ref ||
				!connection.to?.pinId
			) {
				return null
			}

			if (!connection.color && connection.type) {
				connection.color = getConnectionColor(connection.type)
			}
		}

		return data
	} catch {
		return null
	}
}
