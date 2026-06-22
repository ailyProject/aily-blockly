import { AILY_CLOUD_PROJECTS_PATH, createCloudHeaders, resolveCloudApiBase } from './shared'

import type {
	CloudProjectMutationAction,
	CloudProjectMutationResult,
	RemoteCloudProjectMutationResponse
} from '../types'

/**
 * 执行云项目状态动作。
 * @param input - 动作类型、项目 ID、认证信息与 HTTP 方法
 */
export const requestCloudProjectMutation = async (input: {
	action: CloudProjectMutationAction
	projectId: string
	authToken: string
	method: 'POST' | 'DELETE'
	suffix?: string
}): Promise<CloudProjectMutationResult> => {
	const apiBase = resolveCloudApiBase()
	const suffix = input.suffix ? `/${input.suffix}` : ''
	const response = await fetch(`${apiBase}${AILY_CLOUD_PROJECTS_PATH}/${input.projectId}${suffix}`, {
		method: input.method,
		headers: createCloudHeaders(input.authToken)
	})

	let payload: RemoteCloudProjectMutationResponse | null = null
	try {
		payload = (await response.json()) as RemoteCloudProjectMutationResponse
	} catch {
		payload = null
	}

	if (!response.ok || (payload && payload.status !== undefined && payload.status !== 200 && payload.status !== '200')) {
		throw new Error(payload?.message?.trim() || `Cloud request failed: ${response.status}`)
	}

	return {
		success: true,
		action: input.action,
		projectId: input.projectId,
		message: payload?.message?.trim() || `${input.action} succeeded`
	}
}
