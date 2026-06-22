import { normalizeProjectBlocklyRegistryUrl } from './shared'

const LIBRARY_PACKAGE_VERSION_LIST_CACHE_TTL_MS = 5 * 60 * 1000

type RemoteRegistryPackageVersionListResponse = {
	list?: Array<string>
}

const registryPackageVersionListCache = new Map<string, { value: Array<string>; expiresAt: number }>()
const registryPackageVersionListInflight = new Map<string, Promise<Array<string>>>()

/**
 * 从 registry 读取带版本的完整包列表。
 * @param registry - 当前 registry 地址
 */
export const getProjectBlocklyRegistryPackageVersionList = async (registry?: string) => {
	const registryUrl = normalizeProjectBlocklyRegistryUrl(registry)
	const now = Date.now()
	const cached = registryPackageVersionListCache.get(registryUrl)
	if (cached && cached.expiresAt > now) {
		return cached.value
	}

	const inflight = registryPackageVersionListInflight.get(registryUrl)
	if (inflight) {
		return inflight
	}

	const request = (async () => {
		const response = await fetch(`${registryUrl}/vc-package-versions.json`)
		if (!response.ok) {
			throw new Error(`Registry package version list failed: ${response.status}`)
		}

		const payload = (await response.json()) as RemoteRegistryPackageVersionListResponse
		const value = Array.isArray(payload.list)
			? payload.list.filter(item => typeof item === 'string' && item.trim().length > 0)
			: []
		registryPackageVersionListCache.set(registryUrl, {
			value,
			expiresAt: Date.now() + LIBRARY_PACKAGE_VERSION_LIST_CACHE_TTL_MS
		})
		return value
	})()

	registryPackageVersionListInflight.set(registryUrl, request)
	try {
		return await request
	} finally {
		registryPackageVersionListInflight.delete(registryUrl)
	}
}
