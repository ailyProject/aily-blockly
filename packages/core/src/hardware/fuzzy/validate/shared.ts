import { calculateSimilarity, extractKeywords } from '../keywords'

export const fuzzyThreshold = 0.3

export const createLegacyQueryKeywords = (query: string) => extractKeywords(query.toLowerCase().trim())

export const calculateLegacyDescriptionScore = (description: string | undefined, queryKeywords: Array<string>) => {
	let descriptionScore = 0
	const normalizedDescription = description?.toLowerCase() || ''
	for (const queryKeyword of queryKeywords) {
		if (normalizedDescription.includes(queryKeyword)) {
			descriptionScore += 0.3
		}
	}
	return descriptionScore
}

export const calculateLegacySimilarity = (query: string, value: string | undefined) =>
	calculateSimilarity(query.toLowerCase().trim(), value?.toLowerCase() || '')
