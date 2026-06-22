import { requestCloudProjectMutation } from './request'

/**
 * 删除云项目。
 * @param projectId - 目标项目 ID
 * @param authToken - Bearer token
 */
export const deleteCloudProject = (projectId: string, authToken: string) =>
	requestCloudProjectMutation({
		action: 'delete',
		projectId,
		authToken,
		method: 'DELETE'
	})
