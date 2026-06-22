import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

import type { ClassValue } from 'clsx'

export function hlm(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs))
}

const classListCache = new Map<string, string[]>()

export function toClassList(className: string | ClassValue[]): string[] {
	if (typeof className === 'string' && classListCache.has(className)) {
		return classListCache.get(className)!
	}

	const result = clsx(className)
		.split(' ')
		.filter(c => c.length > 0)

	if (typeof className === 'string' && classListCache.size < 1000) {
		classListCache.set(className, result)
	}

	return result
}
