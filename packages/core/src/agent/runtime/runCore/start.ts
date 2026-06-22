import { convertToModelMessages, smoothStream, stepCountIs, streamText } from 'ai'

import { resolveAgentModel } from '../../models'
import { buildSystemPrompt } from '../../prompts'
import { normalizeAgentRuntimeConfig, rebuildSessionFromTurns } from '../../session'
import { createAgentTurn } from '../../session/turns'
import { buildToolSet } from '../../tools'
import { createMessageId, createTextMessage } from '../../utils'
import { ensureRuntimeSession } from './session'

import type { AgentRuntime } from '../AgentRuntime'
import type { AgentUiMessageChunk } from '../events'
import type { AgentRunInput } from '../types'

/**
 * 准备一次完整的 agent 流式运行。
 * @param runtime - AgentRuntime 实例
 * @param input - 运行输入
 */
export const startAgentRuntimeRun = async (runtime: AgentRuntime, input: AgentRunInput) => {
	const runtimeConfig = normalizeAgentRuntimeConfig(input.runtimeConfig)
	const session = await ensureRuntimeSession(runtime, {
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

	const [eventStream, messageStream] = uiStream.tee()
	return {
		session: sessionWithUserMessage,
		userMessage,
		eventStream,
		messageStream
	}
}
