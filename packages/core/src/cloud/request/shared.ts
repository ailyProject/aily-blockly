import {
	AILY_API_SERVER,
	AILY_CLOUD_PROJECT_TEMPLATES_PATH,
	AILY_CLOUD_PROJECTS_PATH,
	AILY_CLOUD_PUBLIC_PROJECTS_PATH,
	DEFAULT_REGION_KEY
} from 'shared'

import { getCurrentApiServer } from '../../project/regions'

export { AILY_CLOUD_PROJECTS_PATH, AILY_CLOUD_PROJECT_TEMPLATES_PATH, AILY_CLOUD_PUBLIC_PROJECTS_PATH } from 'shared'

/**
 * 解析当前云服务 API 根地址。
 */
export const resolveCloudApiBase = () =>
	(AILY_API_SERVER || getCurrentApiServer(undefined, undefined, DEFAULT_REGION_KEY)).replace(/\/$/, '')

/**
 * 创建云接口请求头。
 * @param authToken - 可选 Bearer token
 */
export const createCloudHeaders = (authToken?: string) => {
	const headers = new Headers()
	if (authToken?.trim()) {
		headers.set('Authorization', `Bearer ${authToken.trim()}`)
	}

	return headers
}
