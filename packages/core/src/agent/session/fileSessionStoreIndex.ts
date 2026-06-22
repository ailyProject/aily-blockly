import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
	getAgentSessionIndexFilePath,
	getAgentSessionsDirPath,
	isMissingAgentSessionFile
} from './fileSessionStorePaths'

import type { SessionIndexEntry, SessionIndexFile } from './fileSessionStoreTypes'
import type { SerializedAgentSession } from './serialization/types'

/**
 * 确保 agent session 存储目录结构存在。
 * @param baseDir - 存储根目录
 */
export const ensureAgentSessionLayout = async (baseDir: string) => {
	await mkdir(getAgentSessionsDirPath(baseDir), { recursive: true })
}

/**
 * 读取 agent session 索引文件。
 * @param baseDir - 存储根目录
 */
export const loadAgentSessionIndex = async (baseDir: string): Promise<SessionIndexFile> => {
	try {
		const raw = await readFile(getAgentSessionIndexFilePath(baseDir), 'utf8')
		const parsed = JSON.parse(raw) as SessionIndexFile
		if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
			throw new Error('Invalid agent session index format')
		}
		return parsed
	} catch (error) {
		if (isMissingAgentSessionFile(error)) {
			return rebuildAgentSessionIndexFromDisk(baseDir)
		}
		throw error
	}
}

/**
 * 从磁盘会话文件重建索引。
 * @param baseDir - 存储根目录
 */
export const rebuildAgentSessionIndexFromDisk = async (baseDir: string): Promise<SessionIndexFile> => {
	await ensureAgentSessionLayout(baseDir)

	const dirEntries = await readdir(getAgentSessionsDirPath(baseDir), { withFileTypes: true })
	const sessionFiles = dirEntries
		.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
		.map(entry => entry.name)

	const sessions = await Promise.all(
		sessionFiles.map(async fileName => {
			const filePath = path.join(getAgentSessionsDirPath(baseDir), fileName)
			const raw = await readFile(filePath, 'utf8')
			const parsed = JSON.parse(raw) as SerializedAgentSession
			const fileStat = await stat(filePath)
			return {
				id: parsed.id,
				title: parsed.title,
				createdAt: parsed.createdAt,
				updatedAt: parsed.updatedAt || fileStat.mtime.toISOString()
			} satisfies SessionIndexEntry
		})
	)

	sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

	const index = {
		version: 1,
		sessions
	} satisfies SessionIndexFile
	await writeAgentSessionIndex(baseDir, index)
	return index
}

/**
 * 写回 agent session 索引。
 * @param baseDir - 存储根目录
 * @param index - 索引数据
 */
export const writeAgentSessionIndex = async (baseDir: string, index: SessionIndexFile) => {
	await ensureAgentSessionLayout(baseDir)
	await writeFile(getAgentSessionIndexFilePath(baseDir), JSON.stringify(index, null, 2) + '\n', 'utf8')
}
