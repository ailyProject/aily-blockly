/**
 * 创建稳定的终端会话 ID。
 */
export const createTerminalSessionId = () => `terminal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
