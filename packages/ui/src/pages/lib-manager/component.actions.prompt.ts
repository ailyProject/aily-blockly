import { findCatalogLibraryByName } from './component.helpers'

import type { LibManagerActionContext, LibManagerInstallPrompt } from './types'

/**
 * 解析当前库安装前的兼容确认提示。
 * @param state - 当前页面状态
 * @param packageName - 目标库包名
 * @param version - 目标版本
 * @param localPath - 本地路径
 */
export const resolveLibManagerInstallPrompt = (
	state: ReturnType<LibManagerActionContext['state']>,
	packageName: string,
	version?: string,
	localPath?: string
): LibManagerInstallPrompt | null => {
	if (!state?.boardId) return null

	const catalogItem = findCatalogLibraryByName(packageName)
	if (!catalogItem || catalogItem.compatibleHardware.includes(state.boardId)) {
		return null
	}

	return {
		packageName,
		displayName: catalogItem.displayName,
		currentBoardId: state.boardId,
		supportedBoards: [...catalogItem.compatibleHardware],
		compatibilityText: `This library is not listed for ${state.boardId}.`,
		version,
		localPath
	}
}
