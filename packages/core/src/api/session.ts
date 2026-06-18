import { createUIMessageStream, JsonToSseTransformStream } from 'ai'

import { createAgentRuntime } from '../agent'
import { createAgentRunStream } from '../agent/runtime'
import { hasExistingStream, resumableStream } from './rstream'

import type { AgentSessionRequest } from '@shared'
import type { Context } from 'hono'

const runtime = createAgentRuntime()

export const post = async (c: Context) => {
	const body = await c.req.json<AgentSessionRequest>()
	const streamRun = await createAgentRunStream(runtime, {
		sessionId: body.id,
		title: body.title,
		text: body.text,
		model: body.model,
		runtimeConfig: body.runtimeConfig,
		metadata: body.metadata
	})

	void streamRun.completed.catch(() => null)

	const stream = resumableStream(body.id, () => streamRun.stream.pipeThrough(new JsonToSseTransformStream()))
	if (!stream) return c.body(null, 204)

	return c.newResponse(stream)
}

export const get = async (c: Context) => {
	const id = c.req.query('id')
	if (!id || !hasExistingStream(id)) return c.body(null, 204)

	const emptyStream = createUIMessageStream({ execute: () => {} })
	const stream = resumableStream(id, () => emptyStream.pipeThrough(new JsonToSseTransformStream()))
	if (!stream) return c.body(null, 204)

	return c.newResponse(stream)
}
