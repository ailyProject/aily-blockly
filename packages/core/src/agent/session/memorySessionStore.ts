import type { AgentSession, AgentSessionStore } from './types'

export class MemoryAgentSessionStore implements AgentSessionStore {
	private readonly sessions = new Map<string, AgentSession>()

	async get(sessionId: string): Promise<AgentSession | null> {
		return this.sessions.get(sessionId) ?? null
	}

	async save(session: AgentSession): Promise<void> {
		this.sessions.set(session.id, session)
	}

	async delete(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId)
	}

	async list(): Promise<Array<AgentSession>> {
		return [...this.sessions.values()]
	}
}
