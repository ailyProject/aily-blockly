const DONE = '__AILY_DONE__'

type StreamState = {
	chunks: Array<string>
	controllers: Set<ReadableStreamDefaultController<string>>
	done: boolean
}

const states = new Map<string, StreamState>()

const getState = (id: string) => states.get(id)

const ensureState = (id: string) => {
	const state = states.get(id)
	if (state) return state

	const nextState: StreamState = {
		chunks: [],
		controllers: new Set(),
		done: false
	}
	states.set(id, nextState)
	return nextState
}

const closeState = (id: string) => {
	const state = states.get(id)
	if (!state) return

	state.done = true
	for (const controller of state.controllers) {
		try {
			controller.close()
		} catch {}
	}
	state.controllers.clear()
}

/**
 * 判断是否存在仍可恢复的流。
 * @param id - 流唯一 ID
 */
export const hasExistingStream = (id: string) => Boolean(getState(id) && !getState(id)?.done)

/**
 * 创建或恢复可续传的字符串流。
 * @param id - 流唯一 ID
 * @param makeStream - 创建新流的工厂函数
 */
export const resumableStream = (id: string, makeStream: () => ReadableStream<string>) => {
	const existing = getState(id)
	if (existing) {
		if (existing.done) return null
		return resumeExistingStream(id)
	}

	const state = ensureState(id)
	return new ReadableStream<string>({
		async start(controller) {
			const stream = makeStream()
			const reader = stream.getReader()

			while (true) {
				const { done, value } = await reader.read()
				if (done) {
					closeState(id)
					break
				}

				state.chunks.push(value)
				try {
					controller.enqueue(value)
				} catch {}
				for (const current of state.controllers) {
					try {
						current.enqueue(value)
					} catch {}
				}
			}
		}
	})
}

/**
 * 恢复一个已存在的可续传流。
 * @param id - 流唯一 ID
 */
export const resumeExistingStream = (id: string) => {
	const state = getState(id)
	if (!state || state.done) return null

	return new ReadableStream<string>({
		start(controller) {
			for (const chunk of state.chunks) {
				controller.enqueue(chunk)
			}
			state.controllers.add(controller)
		},
		cancel() {
			state.controllers.clear()
		}
	})
}

/**
 * 清理某个流状态。
 * @param id - 流唯一 ID
 */
export const clearResumableStream = (id: string) => {
	states.delete(id)
}

/**
 * 主动取消并清理某个流。
 * @param id - 流唯一 ID
 */
export const unsubscribe = (id: string) => {
	const state = getState(id)
	if (!state) return

	closeState(id)
	clearResumableStream(id)
}
