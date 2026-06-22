import { requestCloudProjectMutation } from './request'

/**
 * 取消发布云项目。
 * @param projectId - 目标项目 ID
 * @param authToken - Bearer token
 */
export const unpublishCloudProject = (projectId: string, authToken: string) =>
	requestCloudProjectMutation({
		action: 'unpublish',
		projectId,
		authToken,
		method: 'DELETE',
		suffix: 'publish'
	})
