export type ResumableStreamState = {
	chunks: Array<string>
	controllers: Set<ReadableStreamDefaultController<string>>
	done: boolean
}

const states = new Map<string, ResumableStreamState>()

export const getResumableStreamState = (id: string) => states.get(id)

export const ensureResumableStreamState = (id: string) => {
	const state = states.get(id)
	if (state) return state

	const nextState: ResumableStreamState = {
		chunks: [],
		controllers: new Set(),
		done: false
	}
	states.set(id, nextState)
	return nextState
}

export const clearResumableStream = (id: string) => {
	states.delete(id)
}

export const closeResumableStreamState = (id: string) => {
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
