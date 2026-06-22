/**
 * 会话索引中的单条摘要记录。
 */
export interface SessionIndexEntry {
	id: string
	title: string
	createdAt: string
	updatedAt: string
}

/**
 * 会话索引文件结构。
 */
export interface SessionIndexFile {
	version: 1
	sessions: Array<SessionIndexEntry>
}
