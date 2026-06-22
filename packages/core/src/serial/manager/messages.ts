import { serialSessions } from '../state'
import { getSerialSessionSnapshot } from './shared'

/**
 * 拉取并清空当前会话缓冲消息。
 * @param portPath - 串口路径
 */
export const drainSerialSessionMessages = (portPath: string) => {
	const session = serialSessions.get(portPath)
	if (!session) return []

	const messages = [...session.messages]
	session.messages = []
	return messages
}

export { getSerialSessionSnapshot }
