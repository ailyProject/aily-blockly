import { readFile, rm, writeFile } from 'node:fs/promises'

import { ensureAgentSessionLayout, loadAgentSessionIndex, writeAgentSessionIndex } from './fileSessionStoreIndex'
import { getAgentSessionFilePath, isMissingAgentSessionFile } from './fileSessionStorePaths'
import { deserializeAgentSession, serializeAgentSession } from './serialization'

import type { SessionIndexEntry } from './fileSessionStoreTypes'
import type { SerializedAgentSession } from './serialization/types'
import type { AgentSession, AgentSessionStore } from './types'

export class FileAgentSessionStore implements AgentSessionStore {
	constructor(private readonly baseDir: string) {}

	async get(sessionId: string): Promise<AgentSession | null> {
		try {
			const raw = await readFile(getAgentSessionFilePath(this.baseDir, sessionId), 'utf8')
			return deserializeAgentSession(JSON.parse(raw) as SerializedAgentSession)
		} catch (error) {
			if (isMissingAgentSessionFile(error)) return null
			throw error
		}
	}

	async save(session: AgentSession): Promise<void> {
		await ensureAgentSessionLayout(this.baseDir)

		const serialized = serializeAgentSession(session)
		await writeFile(
			getAgentSessionFilePath(this.baseDir, session.id),
			JSON.stringify(serialized, null, 2) + '\n',
			'utf8'
		)

		const index = await loadAgentSessionIndex(this.baseDir)
		const nextEntry: SessionIndexEntry = {
			id: session.id,
			title: session.title,
			createdAt: session.createdAt.toISOString(),
			updatedAt: session.updatedAt.toISOString()
		}
		const current = index.sessions.filter(entry => entry.id !== session.id)
		current.push(nextEntry)
		current.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))

		await writeAgentSessionIndex(this.baseDir, {
			version: 1,
			sessions: current
		})
	}

	async delete(sessionId: string): Promise<void> {
		await rm(getAgentSessionFilePath(this.baseDir, sessionId), { force: true })

		const index = await loadAgentSessionIndex(this.baseDir)
		await writeAgentSessionIndex(this.baseDir, {
			version: 1,
			sessions: index.sessions.filter(entry => entry.id !== sessionId)
		})
	}

	async list(): Promise<Array<AgentSession>> {
		await ensureAgentSessionLayout(this.baseDir)

		const index = await loadAgentSessionIndex(this.baseDir)
		const sessions = await Promise.all(index.sessions.map(entry => this.get(entry.id)))
		return sessions.filter((session): session is AgentSession => session !== null)
	}
}
