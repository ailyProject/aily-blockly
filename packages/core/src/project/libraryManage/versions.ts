import { getProjectBlocklyRegistryPackageVersionList } from './registry'
import { normalizeProjectBlocklyRegistryUrl } from './registry/shared'
import { assertBlocklyLibraryPackageName } from './shared'

import type { ProjectBlocklyLibraryVersionListResult } from '../types'

const LIBRARY_VERSION_CACHE_TTL_MS = 5 * 60 * 1000

type RemoteRegistryPackument = {
	'dist-tags'?: {
		latest?: string
	}
	versions?: Record<string, unknown>
	time?: Record<string, string>
}

const libraryVersionCache = new Map<string, { value: ProjectBlocklyLibraryVersionListResult; expiresAt: number }>()
const libraryVersionInflight = new Map<string, Promise<ProjectBlocklyLibraryVersionListResult>>()

const compareVersionRecency = (left: string, right: string, timeMap: Record<string, string>) => {
	const leftTime = Date.parse(timeMap[left] || '')
	const rightTime = Date.parse(timeMap[right] || '')
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
		return rightTime - leftTime
	}

	return right.localeCompare(left, undefined, {
		numeric: true,
		sensitivity: 'base'
	})
}

/**
 * 从 npm registry 读取指定 Blockly 库的版本列表。
 * @param input - 目标包名与可选 registry 地址
 */
export const listProjectBlocklyLibraryVersions = async (input: {
	packageName: string
	registry?: string
}): Promise<ProjectBlocklyLibraryVersionListResult> => {
	assertBlocklyLibraryPackageName(input.packageName)

	const registry = normalizeProjectBlocklyRegistryUrl(input.registry)
	const cacheKey = `${registry}::${input.packageName}`
	const now = Date.now()
	const cached = libraryVersionCache.get(cacheKey)
	if (cached && cached.expiresAt > now) {
		return cached.value
	}

	const inflight = libraryVersionInflight.get(cacheKey)
	if (inflight) {
		return inflight
	}

	const request = (async () => {
		try {
			const versionList = await getProjectBlocklyRegistryPackageVersionList(registry)
			const versions = versionList
				.map(value => value.trim())
				.filter(value => value.startsWith(`${input.packageName}@`))
				.map(value => value.slice(input.packageName.length + 1))
				.filter(Boolean)
				.sort((left, right) => compareVersionRecency(left, right, {}))

			if (versions.length > 0) {
				const value = {
					packageName: input.packageName,
					registry,
					latestVersion: versions[0],
					versions
				} satisfies ProjectBlocklyLibraryVersionListResult
				libraryVersionCache.set(cacheKey, {
					value,
					expiresAt: Date.now() + LIBRARY_VERSION_CACHE_TTL_MS
				})
				return value
			}
		} catch {
			// fall through to per-package packument lookup
		}

		const response = await fetch(`${registry}/${encodeURIComponent(input.packageName)}`)
		if (!response.ok) {
			throw new Error(`Registry request failed: ${response.status}`)
		}

		const payload = (await response.json()) as RemoteRegistryPackument
		const versions = Object.keys(payload.versions || {})
		const timeMap = payload.time || {}
		versions.sort((left, right) => compareVersionRecency(left, right, timeMap))

		const value = {
			packageName: input.packageName,
			registry,
			latestVersion: payload['dist-tags']?.latest,
			versions
		} satisfies ProjectBlocklyLibraryVersionListResult
		libraryVersionCache.set(cacheKey, {
			value,
			expiresAt: Date.now() + LIBRARY_VERSION_CACHE_TTL_MS
		})
		return value
	})()

	libraryVersionInflight.set(cacheKey, request)
	try {
		return await request
	} finally {
		libraryVersionInflight.delete(cacheKey)
	}
}
