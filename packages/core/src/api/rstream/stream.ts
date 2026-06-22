import {
	clearResumableStream,
	closeResumableStreamState,
	ensureResumableStreamState,
	getResumableStreamState
} from './state'

/**
 * 判断是否存在仍可恢复的流。
 * @param id - 流唯一 ID
 */
export const hasExistingStream = (id: string) =>
	Boolean(getResumableStreamState(id) && !getResumableStreamState(id)?.done)

/**
 * 恢复一个已存在的可续传流。
 * @param id - 流唯一 ID
 */
export const resumeExistingStream = (id: string) => {
	const state = getResumableStreamState(id)
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
 * 创建或恢复可续传的字符串流。
 * @param id - 流唯一 ID
 * @param makeStream - 创建新流的工厂函数
 */
export const resumableStream = (id: string, makeStream: () => ReadableStream<string>) => {
	const existing = getResumableStreamState(id)
	if (existing) {
		if (existing.done) return null
		return resumeExistingStream(id)
	}

	const state = ensureResumableStreamState(id)
	return new ReadableStream<string>({
		async start(controller) {
			const stream = makeStream()
			const reader = stream.getReader()

			while (true) {
				const { done, value } = await reader.read()
				if (done) {
					closeResumableStreamState(id)
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
 * 主动取消并清理某个流。
 * @param id - 流唯一 ID
 */
export const unsubscribe = (id: string) => {
	const state = getResumableStreamState(id)
	if (!state) return

	closeResumableStreamState(id)
	clearResumableStream(id)
}
