import { AILY_API_SERVER, DEFAULT_REGION_KEY } from 'shared'

import { getCurrentApiServer } from '../../../project'
import { resolveRemoteTargetLibraries } from '../shared'
import { syncRemotePinmapsForLibrary } from './library'
import { createRemoteSyncHeaders, readRemoteLocalPackageDirs } from './shared'

import type { AilyAppConfig } from 'shared'

/**
 * 从云端同步 pinmap 到本地包目录。
 * @param input - 云端同步输入
 */
export const syncConnectionPinmapComponentsFromApi = async (input: {
	config?: AilyAppConfig
	packagesBasePath: string
	pinmapIdHints?: Array<string>
	authToken?: string
	headers?: Record<string, string>
}): Promise<number> => {
	try {
		const apiBase =
			getCurrentApiServer(input.config?.regions, input.config?.region, DEFAULT_REGION_KEY) || AILY_API_SERVER
		const localHeaders = createRemoteSyncHeaders({
			headers: input.headers,
			authToken: input.authToken
		})
		if (!localHeaders['Authorization'] && !localHeaders['authorization']) return 0

		const ailyRoot = `${input.packagesBasePath}/@aily-project`
		const packageDirs = await readRemoteLocalPackageDirs(ailyRoot)
		if (packageDirs.length === 0) return 0

		const targetLibraries = resolveRemoteTargetLibraries(packageDirs, input.pinmapIdHints)
		const localPackageSet = new Set(packageDirs)
		let synced = 0

		for (const library of targetLibraries) {
			synced += await syncRemotePinmapsForLibrary({
				apiBase,
				library,
				localHeaders,
				localPackageSet,
				ailyRoot,
				packagesBasePath: input.packagesBasePath
			})
		}

		return synced
	} catch {
		return 0
	}
}
