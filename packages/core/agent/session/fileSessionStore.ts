import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { deserializeAgentSession, serializeAgentSession } from './serialization'

import type { SerializedAgentSession } from './serialization'
import type { AgentSession, AgentSessionStore } from './types'

interface SessionIndexEntry {
	id: string
	title: string
	createdAt: string
	updatedAt: string
}

interface SessionIndexFile {
	version: 1
	sessions: Array<SessionIndexEntry>
}

const INDEX_FILE = 'index.json'
const SESSIONS_DIR = 'sessions'

export class FileAgentSessionStore implements AgentSessionStore {
	constructor(private readonly baseDir: string) {}

	async get(sessionId: string): Promise<AgentSession | null> {
		try {
			const raw = await readFile(this.getSessionFilePath(sessionId), 'utf8')
			return deserializeAgentSession(JSON.parse(raw) as SerializedAgentSession)
		} catch (error) {
			if (this.isMissing(error)) return null
			throw error
		}
	}

	async save(session: AgentSession): Promise<void> {
		await this.ensureLayout()

		const serialized = serializeAgentSession(session)
		await writeFile(this.getSessionFilePath(session.id), JSON.stringify(serialized, null, 2) + '\n', 'utf8')

		const index = await this.loadIndex()
		const nextEntry: SessionIndexEntry = {
			id: session.id,
			title: session.title,
			createdAt: session.createdAt.toISOString(),
			updatedAt: session.updatedAt.toISOString()
		}
		const current = index.sessions.filter(entry => entry.id !== session.id)
		current.push(nextEntry)
		current.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

		await this.writeIndex({
			version: 1,
			sessions: current
		})
	}

	async delete(sessionId: string): Promise<void> {
		await rm(this.getSessionFilePath(sessionId), { force: true })

		const index = await this.loadIndex()
		await this.writeIndex({
			version: 1,
			sessions: index.sessions.filter(entry => entry.id !== sessionId)
		})
	}

	async list(): Promise<Array<AgentSession>> {
		await this.ensureLayout()

		const index = await this.loadIndex()
		const sessions = await Promise.all(index.sessions.map(entry => this.get(entry.id)))
		return sessions.filter((session): session is AgentSession => session !== null)
	}

	private async ensureLayout() {
		await mkdir(this.getSessionsDirPath(), { recursive: true })
	}

	private async loadIndex(): Promise<SessionIndexFile> {
		try {
			const raw = await readFile(this.getIndexFilePath(), 'utf8')
			const parsed = JSON.parse(raw) as SessionIndexFile
			if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
				throw new Error('Invalid agent session index format')
			}
			return parsed
		} catch (error) {
			if (this.isMissing(error)) {
				return this.rebuildIndexFromDisk()
			}
			throw error
		}
	}

	private async rebuildIndexFromDisk(): Promise<SessionIndexFile> {
		await this.ensureLayout()

		const dirEntries = await readdir(this.getSessionsDirPath(), { withFileTypes: true })
		const sessionFiles = dirEntries
			.filter(entry => entry.isFile() && entry.name.endsWith('.json'))
			.map(entry => entry.name)

		const sessions = await Promise.all(
			sessionFiles.map(async fileName => {
				const filePath = path.join(this.getSessionsDirPath(), fileName)
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
		await this.writeIndex(index)
		return index
	}

	private async writeIndex(index: SessionIndexFile) {
		await this.ensureLayout()
		await writeFile(this.getIndexFilePath(), JSON.stringify(index, null, 2) + '\n', 'utf8')
	}

	private getIndexFilePath() {
		return path.join(this.baseDir, INDEX_FILE)
	}

	private getSessionsDirPath() {
		return path.join(this.baseDir, SESSIONS_DIR)
	}

	private getSessionFilePath(sessionId: string) {
		return path.join(this.getSessionsDirPath(), `${sessionId}.json`)
	}

	private isMissing(error: unknown) {
		return error instanceof Error && 'code' in error && error.code === 'ENOENT'
	}
}
