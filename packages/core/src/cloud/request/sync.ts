import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { AILY_CLOUD_SYNC_PATH } from 'shared'

import { createCloudHeaders, resolveCloudApiBase } from './shared'

import type { CloudProjectSyncInput, CloudProjectSyncResult, RemoteCloudProjectSyncResponse } from '../types'

const normalizeCloudProjectId = (value: unknown) => String(value ?? '').trim()

const createCloudSyncFormData = async (input: CloudProjectSyncInput) => {
	const formData = new FormData()
	formData.append('projectData', JSON.stringify(input.projectData))

	if (input.projectId?.trim()) {
		formData.append('pid', input.projectId.trim())
	}

	if (input.archivePath?.trim()) {
		const archivePath = input.archivePath.trim()
		const archiveBytes = await readFile(archivePath)
		formData.append('archive', new Blob([archiveBytes]), path.basename(archivePath))
	}

	return formData
}

/**
 * 同步云项目归档与元数据。
 * @param input - 项目元数据、归档与认证信息
 */
export const syncCloudProject = async (input: CloudProjectSyncInput): Promise<CloudProjectSyncResult> => {
	const response = await fetch(`${resolveCloudApiBase()}${AILY_CLOUD_SYNC_PATH}`, {
		method: 'POST',
		headers: createCloudHeaders(input.authToken),
		body: await createCloudSyncFormData(input)
	})

	let payload: RemoteCloudProjectSyncResponse | null = null
	try {
		payload = (await response.json()) as RemoteCloudProjectSyncResponse
	} catch {
		payload = null
	}

	if (!response.ok || (payload?.status !== undefined && payload.status !== 200 && payload.status !== '200')) {
		throw new Error(payload?.message?.trim() || `Cloud request failed: ${response.status}`)
	}

	return {
		success: true,
		projectId: normalizeCloudProjectId(payload?.data?.id ?? input.projectId ?? ''),
		message: payload?.message?.trim() || 'sync succeeded'
	}
}
