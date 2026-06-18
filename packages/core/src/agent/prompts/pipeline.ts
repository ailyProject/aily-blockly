import type { PromptBuildContext, PromptElement, PromptElementProvider, PromptRenderResult } from './types'

interface FlattenedUnit {
	elementId: string
	priority: number
	tokens: number
	order: number
	evictable: boolean
	messages: PromptElement['messages']
}

export class PromptPipeline {
	private readonly providers: Array<PromptElementProvider> = []

	register(provider: PromptElementProvider): this {
		this.providers.push(provider)
		return this
	}

	registerAll(providers: Array<PromptElementProvider>): this {
		providers.forEach(provider => this.register(provider))
		return this
	}

	async render(context: PromptBuildContext, tokenBudget: number): Promise<PromptRenderResult> {
		const elements: Array<PromptElement> = []
		for (const provider of this.providers) {
			const element = await provider.build(context)
			if (element) elements.push(element)
		}

		const units = this.flatten(elements)
		let totalTokens = units.reduce((sum, unit) => sum + unit.tokens, 0)
		const evictedIds = new Set<string>()

		if (totalTokens > tokenBudget) {
			const evictionOrder = [...units]
				.filter(unit => unit.evictable)
				.sort((left, right) => {
					if (left.priority !== right.priority) return left.priority - right.priority
					return left.order - right.order
				})

			for (const unit of evictionOrder) {
				if (totalTokens <= tokenBudget) break
				if (evictedIds.has(unit.elementId)) continue

				evictedIds.add(unit.elementId)
				totalTokens -= unit.tokens
			}
		}

		const keptUnits = units
			.filter(unit => !evictedIds.has(unit.elementId))
			.sort((left, right) => left.order - right.order)

		return {
			messages: keptUnits.flatMap(unit => unit.messages),
			totalTokens,
			budget: tokenBudget,
			evictedCount: evictedIds.size,
			elementBreakdown: elements.map(element => ({
				id: element.id,
				priority: element.priority,
				tokens: element.tokens,
				messageCount: element.messages.length,
				evicted: evictedIds.has(element.id)
			}))
		}
	}

	private flatten(elements: Array<PromptElement>, units: Array<FlattenedUnit> = [], order = { value: 0 }) {
		for (const element of elements) {
			const currentOrder = order.value++
			if (element.messages.length > 0) {
				units.push({
					elementId: element.id,
					priority: element.priority,
					tokens: element.tokens,
					order: currentOrder,
					evictable: element.evictable !== false,
					messages: element.messages
				})
			}

			if (element.children?.length) {
				this.flatten(element.children, units, order)
			}
		}

		return units
	}
}
