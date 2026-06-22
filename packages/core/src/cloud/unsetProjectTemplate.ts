import { requestCloudProjectMutation } from './request'

/**
 * 取消云项目的模板标记。
 * @param projectId - 目标项目 ID
 * @param authToken - Bearer token
 */
export const unsetCloudProjectTemplate = (projectId: string, authToken: string) =>
	requestCloudProjectMutation({
		action: 'unset-template',
		projectId,
		authToken,
		method: 'DELETE',
		suffix: 'template'
	})
