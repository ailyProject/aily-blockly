import { requestCloudProjectMutation } from './request'

/**
 * 将云项目标记为模板。
 * @param projectId - 目标项目 ID
 * @param authToken - Bearer token
 */
export const setCloudProjectTemplate = (projectId: string, authToken: string) =>
	requestCloudProjectMutation({
		action: 'set-template',
		projectId,
		authToken,
		method: 'POST',
		suffix: 'template'
	})
