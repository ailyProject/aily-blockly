import path from 'node:path'

const INDEX_FILE = 'index.json'
const SESSIONS_DIR = 'sessions'

/**
 * 解析 agent session index 文件路径。
 * @param baseDir - 存储根目录
 */
export const getAgentSessionIndexFilePath = (baseDir: string) => path.join(baseDir, INDEX_FILE)

/**
 * 解析 agent session 目录路径。
 * @param baseDir - 存储根目录
 */
export const getAgentSessionsDirPath = (baseDir: string) => path.join(baseDir, SESSIONS_DIR)

/**
 * 解析单个 session 文件路径。
 * @param baseDir - 存储根目录
 * @param sessionId - 会话 ID
 */
export const getAgentSessionFilePath = (baseDir: string, sessionId: string) =>
	path.join(getAgentSessionsDirPath(baseDir), `${sessionId}.json`)

/**
 * 判断文件系统异常是否为 ENOENT。
 * @param error - 原始异常
 */
export const isMissingAgentSessionFile = (error: unknown) =>
	error instanceof Error && 'code' in error && error.code === 'ENOENT'
