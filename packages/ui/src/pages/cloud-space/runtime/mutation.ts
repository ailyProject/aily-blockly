import type { Core } from '@/utils/core'
import type { CloudProjectMetadata, CloudProjectMutationAction } from 'shared'

/**
 * 执行当前用户项目的状态动作。
 * @param input - 动作、项目 ID 与认证 token
 */
export const mutateCloudSpaceProject = async (input: {
	core: Core
	projectId: string
	action: CloudProjectMutationAction
	authToken: string
}) => {
	const payload = { projectId: input.projectId, authToken: input.authToken.trim() }
	switch (input.action) {
		case 'publish':
			return input.core.cloud.publishProject.mutate(payload)
		case 'update':
			throw new Error('Metadata updates are handled by the dedicated cloud editor flow.')
		case 'unpublish':
			return input.core.cloud.unpublishProject.mutate(payload)
		case 'set-template':
			return input.core.cloud.setProjectTemplate.mutate(payload)
		case 'unset-template':
			return input.core.cloud.unsetProjectTemplate.mutate(payload)
		case 'delete':
			return input.core.cloud.deleteProject.mutate(payload)
	}
}

/**
 * 更新云项目元数据。
 * @param input - 项目 ID、认证 token 与新的元数据草稿
 */
export const updateCloudSpaceProjectMetadata = (input: {
	core: Core
	projectId: string
	authToken: string
	metadata: CloudProjectMetadata
	imageBase64?: string
	imageName?: string
	removeCover?: boolean
}) =>
	input.core.cloud.updateProject.mutate({
		projectId: input.projectId,
		authToken: input.authToken.trim(),
		...input.metadata,
		...(input.imageBase64 ? { imageBase64: input.imageBase64 } : {}),
		...(input.imageName ? { imageName: input.imageName } : {}),
		...(input.removeCover ? { removeCover: true } : {})
	})
