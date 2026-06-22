import type { HardwareSearchFilters } from '../types'

export const toKeywords = (input?: string | Array<string>) => {
	if (!input) return []
	if (Array.isArray(input)) return input.map(item => item.trim().toLowerCase()).filter(Boolean)

	return input
		.split(/[,，]/)
		.flatMap(part => part.trim().split(/\s+/))
		.map(item => item.trim().toLowerCase())
		.filter(Boolean)
}

export const compareNumeric = (value: number, condition?: string) => {
	if (!condition) return true

	const match = condition.match(/^([<>=!]+)?(\d+(?:\.\d+)?)$/)
	if (!match) return true

	const [, operator, raw] = match
	const expected = Number(raw)
	switch (operator) {
		case '>':
			return value > expected
		case '>=':
			return value >= expected
		case '<':
			return value < expected
		case '<=':
			return value <= expected
		case '!=':
			return value !== expected
		default:
			return value === expected
	}
}

export const includesAll = (source: Array<string>, expected?: Array<string>) =>
	!expected?.length || expected.every(item => source.some(value => value.toLowerCase() === item.toLowerCase()))

export const scoreText = (value: string, query: string, exact: number, partial: number) => {
	const normalized = value.toLowerCase()
	if (normalized === query) return exact
	if (normalized.includes(query)) return partial
	return 0
}

export const convertFiltersToQueries = (
	filters: HardwareSearchFilters | undefined,
	type: 'boards' | 'libraries'
): Array<string> => {
	if (!filters) return []

	const queries: Array<string> = []
	if (type === 'boards') {
		if (filters.architecture) {
			queries.push(filters.architecture.toLowerCase())
			if (filters.architecture.includes('xtensa')) queries.push('esp32')
			if (filters.architecture === 'avr') queries.push('arduino')
		}
		if (filters.connectivity) queries.push(...filters.connectivity.map(item => item.toLowerCase()))
		if (filters.interfaces) queries.push(...filters.interfaces.map(item => item.toLowerCase()))
		if (filters.brand) queries.push(filters.brand.toLowerCase())
		return queries
	}

	if (filters.category) queries.push(filters.category.toLowerCase())
	if (filters.hardwareType) queries.push(...filters.hardwareType.map(item => item.toLowerCase()))
	if (filters.communication) queries.push(...filters.communication.map(item => item.toLowerCase()))
	if (filters.supportedCores) {
		for (const core of filters.supportedCores) {
			queries.push(...core.toLowerCase().split(':').filter(Boolean))
		}
	}

	return queries
}

export const findLegacyDescription = <T extends { name: string; description?: string }>(
	name: string,
	oldData?: Array<T>
) => {
	if (!oldData) return undefined
	const found = oldData.find(
		item => item.name === name || item.name === `@aily-project/${name}` || item.name.endsWith(`/${name}`)
	)
	return found?.description
}
