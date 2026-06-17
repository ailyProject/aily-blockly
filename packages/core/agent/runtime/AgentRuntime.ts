import { convertToModelMessages, readUIMessageStream, smoothStream, stepCountIs, streamText } from 'ai'

import { createNoopAgentCapabilities } from '../capabilities/noop'
import { resolveAgentModel } from '../models/resolveModel'
import { buildSystemPrompt } from '../prompts/buildSystemPrompt'
import { PromptPipeline } from '../prompts/pipeline'
import { ContextPromptProvider } from '../prompts/providers/context'
import { HistoryPromptProvider } from '../prompts/providers/history'
import { ToolContinuationPromptProvider } from '../prompts/providers/toolContinuation'
import { normalizeAgentRuntimeConfig } from '../session/config'
import { createAgentSession } from '../session/createSession'
import { MemoryAgentSessionStore } from '../session/memorySessionStore'
import {
	applySummaryToSession,
	removeIncompleteLastTurn,
	removeSessionFromTurn,
	truncateSessionToTurn
} from '../session/mutations'
import { rebuildSessionFromTurns } from '../session/state'
import { buildAgentTurnResponse, createAgentTurn } from '../session/turns'
import { buildToolSet } from '../tools/buildToolSet'
import { createDefaultToolRegistry } from '../tools/createDefaultToolRegistry'
import { createMessageId } from '../utils/ids'
import { createTextMessage } from '../utils/messages'
import { estimateMessagesTokens } from '../utils/tokens'
import { mapUiChunkToRuntimeEvent } from './events'

import type { AgentCapabilities } from '../capabilities/types'
import type { AgentModelConfig } from '../models/resolveModel'
import type { AgentRuntimeConfig } from '../session/config'
import type { ApplySessionSummaryArgs } from '../session/mutations'
import type { AgentSession, AgentSessionStore, CreateAgentSessionInput } from '../session/types'
import type { AgentToolRegistry } from '../tools/registry'
import type { AgentMessage } from '../types/message'
import type { AgentRuntimeEvent, AgentUiMessageChunk } from './events'

export interface AgentRuntimeOptions {
	capabilities?: AgentCapabilities
	sessionStore?: AgentSessionStore
	registry?: AgentToolRegistry
	promptPipeline?: PromptPipeline
}

export interface AgentRunInput {
	sessionId?: string
	title?: string
	text: string
	model: AgentModelConfig
	runtimeConfig?: Partial<AgentRuntimeConfig>
	metadata?: Record<string, unknown>
	signal?: AbortSignal
}

export interface AgentRunResult {
	session: AgentSession
	responseMessages: Array<AgentMessage>
}

export class AgentRuntime {
	readonly capabilities: AgentCapabilities
	readonly sessionStore: AgentSessionStore
	readonly registry: AgentToolRegistry
	readonly promptPipeline: PromptPipeline

	constructor(options: AgentRuntimeOptions = {}) {
		this.capabilities = options.capabilities ?? createNoopAgentCapabilities()
		this.sessionStore = options.sessionStore ?? new MemoryAgentSessionStore()
		this.registry = options.registry ?? createDefaultToolRegistry()
		this.promptPipeline =
			options.promptPipeline ??
			new PromptPipeline().registerAll([
				new ContextPromptProvider(),
				new HistoryPromptProvider(),
				new ToolContinuationPromptProvider()
			])
	}

	async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
		const session = createAgentSession(input)
		await this.sessionStore.save(session)
		return session
	}

	async getSession(sessionId: string): Promise<AgentSession | null> {
		return this.sessionStore.get(sessionId)
	}

	async saveSession(session: AgentSession): Promise<AgentSession> {
		await this.sessionStore.save(session)
		return session
	}

	async truncateToTurn(sessionId: string, turnId: string): Promise<AgentSession | null> {
		const session = await this.getSession(sessionId)
		if (!session) return null

		const nextSession = truncateSessionToTurn(session, turnId)
		await this.sessionStore.save(nextSession)
		return nextSession
	}

	async removeFromTurn(sessionId: string, turnId: string): Promise<AgentSession | null> {
		const session = await this.getSession(sessionId)
		if (!session) return null

		const nextSession = removeSessionFromTurn(session, turnId)
		await this.sessionStore.save(nextSession)
		return nextSession
	}

	async removeIncompleteLast(sessionId: string): Promise<AgentSession | null> {
		const session = await this.getSession(sessionId)
		if (!session) return null

		const nextSession = removeIncompleteLastTurn(session)
		await this.sessionStore.save(nextSession)
		return nextSession
	}

	async applySummary(sessionId: string, args: ApplySessionSummaryArgs) {
		const session = await this.getSession(sessionId)
		if (!session) {
			return {
				applied: false,
				session: null
			}
		}

		const result = applySummaryToSession(session, args)
		if (result.applied) {
			await this.sessionStore.save(result.session)
		}

		return result
	}

	async *run(input: AgentRunInput): AsyncGenerator<AgentRuntimeEvent, AgentRunResult, void> {
		const runtimeConfig = normalizeAgentRuntimeConfig(input.runtimeConfig)
		const session = await this.ensureSession({
			sessionId: input.sessionId,
			title: input.title,
			runtimeConfig
		})

		const userMessage = createTextMessage({
			role: 'user',
			text: input.text,
			source: runtimeConfig.agentName,
			model: input.model.model
		})
		const pendingTurn = createAgentTurn({
			messages: [userMessage]
		})
		const sessionWithUserMessage = rebuildSessionFromTurns(session, [...session.turns, pendingTurn])
		await this.sessionStore.save(sessionWithUserMessage)
		const resolvedModel = resolveAgentModel(input.model)

		const promptResult = await this.promptPipeline.render(
			{
				session: sessionWithUserMessage,
				runtimeConfig,
				registry: this.registry,
				capabilities: this.capabilities,
				toolCallingIteration: 0
			},
			runtimeConfig.maxPromptTokens
		)

		const systemPrompt = buildSystemPrompt({
			session: sessionWithUserMessage,
			runtimeConfig
		})

		const tools = buildToolSet({
			registry: this.registry,
			session: sessionWithUserMessage,
			runtimeConfig,
			capabilities: this.capabilities,
			signal: input.signal,
			emit: async () => {}
		})

		const result: any = streamText({
			model: resolvedModel.model,
			system: systemPrompt,
			messages: await convertToModelMessages(promptResult.messages),
			tools: {
				...resolvedModel.tools,
				...tools
			},
			abortSignal: input.signal,
			providerOptions: resolvedModel.providerOptions,
			stopWhen: stepCountIs(runtimeConfig.maxSteps),
			experimental_transform: smoothStream(),
			temperature: input.model.temperature,
			topP: input.model.topP,
			maxOutputTokens: input.model.maxOutputTokens
		})

		const uiStream = result.toUIMessageStream({
			originalMessages: [userMessage],
			generateMessageId: createMessageId,
			messageMetadata: ({ part }: { part: { type: string; totalUsage?: unknown } }) => {
				if (part.type !== 'finish') return

				return {
					timestamp: Date.now(),
					source: runtimeConfig.agentName,
					model: input.model.model,
					usage: part.totalUsage
				}
			}
		}) as ReadableStream<AgentUiMessageChunk>

		const [eventStream, messageStream] = uiStream.tee()
		const responseMessagesPromise = this.collectResponseMessages(messageStream)
		const reader = eventStream.getReader()

		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				yield mapUiChunkToRuntimeEvent(value)
			}
		} catch (error) {
			yield {
				type: 'error',
				error,
				message: error instanceof Error ? error.message : String(error)
			}
			throw error
		}

		const responseMessages = await responseMessagesPromise
		const finalSession = await this.commitTurn(sessionWithUserMessage, [userMessage, ...responseMessages])

		return {
			session: finalSession,
			responseMessages
		}
	}

	private async ensureSession(args: {
		sessionId?: string
		title?: string
		runtimeConfig: AgentRuntimeConfig
	}): Promise<AgentSession> {
		if (args.sessionId) {
			const existing = await this.sessionStore.get(args.sessionId)
			if (existing) return existing
		}

		return this.createSession({
			id: args.sessionId,
			title: args.title,
			runtimeConfig: args.runtimeConfig
		})
	}

	private async commitTurn(session: AgentSession, messages: Array<AgentMessage>) {
		const requestMessage = messages.find(message => message.role === 'user')
		if (!requestMessage) {
			throw new Error('Cannot commit turn without a user request message')
		}
		const responseMessages = messages.filter(message => message.role === 'assistant')
		const response = responseMessages.length > 0 ? buildAgentTurnResponse(responseMessages) : undefined
		const turn = createAgentTurn({
			messages,
			request: {
				message: requestMessage,
				timestamp: requestMessage.metadata?.timestamp ?? Date.now(),
				content: requestMessage.parts
					.filter(part => part.type === 'text')
					.map(part => part.text)
					.join('')
			},
			response
		})

		const lastTurn = session.turns[session.turns.length - 1]
		const shouldReplacePendingTurn =
			!!lastTurn && !lastTurn.response && lastTurn.request.message.id === requestMessage.id

		const nextTurns = shouldReplacePendingTurn ? [...session.turns.slice(0, -1), turn] : [...session.turns, turn]
		const nextSession = rebuildSessionFromTurns(session, nextTurns)

		await this.sessionStore.save(nextSession)
		return nextSession
	}

	private async collectResponseMessages(stream: ReadableStream<AgentUiMessageChunk>) {
		const messages: Array<AgentMessage> = []
		for await (const message of readUIMessageStream({ stream })) {
			messages.push(message as AgentMessage)
		}
		return messages
	}

	static estimatePromptTokens(messages: Array<AgentMessage>) {
		return estimateMessagesTokens(messages)
	}
}
