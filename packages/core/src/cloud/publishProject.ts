import { requestCloudProjectMutation } from './request'

/**
 * 发布云项目。
 * @param projectId - 目标项目 ID
 * @param authToken - Bearer token
 */
export const publishCloudProject = (projectId: string, authToken: string) =>
	requestCloudProjectMutation({
		action: 'publish',
		projectId,
		authToken,
		method: 'POST',
		suffix: 'publish'
	})
