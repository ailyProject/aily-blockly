import { getCurrentProjectPath } from '@/runtime/project-session'

import type { Core } from '@/utils/core'
import type { LibManagerPageState } from './types'

/**
 * 读取 lib-manager 页面状态。
 * @param core - core tRPC 句柄
 */
export const loadLibManagerPageState = async (core: Core): Promise<LibManagerPageState | null> => {
	const projectPath = getCurrentProjectPath()
	if (!projectPath) return null
	return core.project.getBlocklyLibraryStatus.query({ projectPath })
}
