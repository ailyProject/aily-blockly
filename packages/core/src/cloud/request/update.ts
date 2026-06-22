import { AILY_CLOUD_PROJECTS_PATH } from 'shared'

import { createCloudHeaders, resolveCloudApiBase } from './shared'

import type { CloudProjectMutationResult } from 'shared'
import type { CloudProjectUpdateInput, RemoteCloudProjectMutationResponse } from '../types'

const createCloudProjectUpdateFormData = async (input: CloudProjectUpdateInput) => {
	const formData = new FormData()
	if (input.nickname?.trim()) {
		formData.append('nickname', input.nickname.trim())
	}
	if (input.description?.trim()) {
		formData.append('description', input.description.trim())
	}
	if (input.docUrl?.trim()) {
		formData.append('doc_url', input.docUrl.trim())
	}
	if (input.tags?.length) {
		formData.append('tags', JSON.stringify(input.tags))
	}
	if (input.imageBase64?.trim()) {
		const imageBytes = Buffer.from(input.imageBase64.trim(), 'base64')
		formData.append('image', new Blob([imageBytes]), input.imageName?.trim() || 'cloud-project-cover.webp')
	}
	if (input.removeCover) {
		formData.append('remove_cover', 'true')
	}
	return formData
}

/**
 * 更新云项目基础元数据。
 * @param input - 项目 ID、认证信息与元数据内容
 */
export const updateCloudProject = async (input: CloudProjectUpdateInput): Promise<CloudProjectMutationResult> => {
	const response = await fetch(`${resolveCloudApiBase()}${AILY_CLOUD_PROJECTS_PATH}/${input.projectId}`, {
		method: 'PUT',
		headers: createCloudHeaders(input.authToken),
		body: await createCloudProjectUpdateFormData(input)
	})

	let payload: RemoteCloudProjectMutationResponse | null = null
	try {
		payload = (await response.json()) as RemoteCloudProjectMutationResponse
	} catch {
		payload = null
	}

	if (!response.ok || (payload?.status !== undefined && payload.status !== 200 && payload.status !== '200')) {
		throw new Error(payload?.message?.trim() || `Cloud request failed: ${response.status}`)
	}

	return {
		success: true,
		action: 'update',
		projectId: input.projectId,
		message: payload?.message?.trim() || 'update succeeded'
	}
}
