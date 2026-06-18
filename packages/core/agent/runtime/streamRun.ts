import { convertToModelMessages, readUIMessageStream, smoothStream, stepCountIs, streamText } from 'ai'

import { resolveAgentModel } from '../models'
import { buildSystemPrompt } from '../prompts'
import { createAgentSession, normalizeAgentRuntimeConfig, rebuildSessionFromTurns } from '../session'
import { buildAgentTurnResponse, createAgentTurn } from '../session/turns'
import { buildToolSet } from '../tools'
import { createMessageId, createTextMessage } from '../utils'

import type { AgentSession } from '../session'
import type { AgentMessage } from '../types/message'
import type { AgentRuntime } from './AgentRuntime'
import type { AgentUiMessageChunk } from './events'
import type { AgentRunInput, AgentRunResult } from './types'

const ensureSession = async (
	runtime: AgentRuntime,
	args: { sessionId?: string; title?: string; runtimeConfig: ReturnType<typeof normalizeAgentRuntimeConfig> }
) => {
	if (args.sessionId) {
		const existing = await runtime.sessionStore.get(args.sessionId)
		if (existing) return existing
	}

	return createAgentSession({
		id: args.sessionId,
		title: args.title,
		runtimeConfig: args.runtimeConfig
	})
}

const commitTurn = async (runtime: AgentRuntime, session: AgentSession, messages: Array<AgentMessage>) => {
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
	const shouldReplacePendingTurn = !!lastTurn && !lastTurn.response && lastTurn.request.message.id === requestMessage.id
	const nextTurns = shouldReplacePendingTurn ? [...session.turns.slice(0, -1), turn] : [...session.turns, turn]
	const nextSession = rebuildSessionFromTurns(session, nextTurns)

	await runtime.sessionStore.save(nextSession)
	return nextSession
}

const collectResponseMessages = async (stream: ReadableStream<AgentUiMessageChunk>) => {
	const messages: Array<AgentMessage> = []
	for await (const message of readUIMessageStream({ stream })) {
		messages.push(message as AgentMessage)
	}
	return messages
}

/**
 * 为 AgentRuntime 构建可直接输出给 API 的 UI message stream。
 * @param runtime - AgentRuntime 实例
 * @param input - 运行输入
 */
export const createAgentRunStream = async (runtime: AgentRuntime, input: AgentRunInput) => {
	const runtimeConfig = normalizeAgentRuntimeConfig(input.runtimeConfig)
	const session = await ensureSession(runtime, {
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
	const pendingTurn = createAgentTurn({ messages: [userMessage] })
	const sessionWithUserMessage = rebuildSessionFromTurns(session, [...session.turns, pendingTurn])
	await runtime.sessionStore.save(sessionWithUserMessage)

	const resolvedModel = resolveAgentModel(input.model)
	const promptResult = await runtime.promptPipeline.render(
		{
			session: sessionWithUserMessage,
			runtimeConfig,
			registry: runtime.registry,
			capabilities: runtime.capabilities,
			toolCallingIteration: 0
		},
		runtimeConfig.maxPromptTokens
	)
	const systemPrompt = buildSystemPrompt({ session: sessionWithUserMessage, runtimeConfig })
	const tools = buildToolSet({
		registry: runtime.registry,
		session: sessionWithUserMessage,
		runtimeConfig,
		capabilities: runtime.capabilities,
		signal: input.signal,
		emit: async () => {}
	})

	const result: any = streamText({
		model: resolvedModel.model,
		system: systemPrompt,
		messages: await convertToModelMessages(promptResult.messages),
		tools: { ...resolvedModel.tools, ...tools },
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

	const [stream, messageStream] = uiStream.tee()
	const completed = collectResponseMessages(messageStream).then(async responseMessages => {
		const finalSession = await commitTurn(runtime, sessionWithUserMessage, [userMessage, ...responseMessages])
		return {
			session: finalSession,
			responseMessages
		} satisfies AgentRunResult
	})

	return {
		session: sessionWithUserMessage,
		stream,
		completed
	}
}
