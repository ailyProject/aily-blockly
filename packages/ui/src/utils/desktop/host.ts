import type { Desktop } from './types'

/**
 * 从 desktop 宿主读取运行时信息。
 * @param desktop - desktop ERPC 句柄。
 */
export const loadDesktopHostRuntimeInfo = (desktop: NonNullable<Desktop>) => desktop.host.getRuntimeInfo.query()

/**
 * 读取并消费 desktop 宿主待打开项目路径。
 * @param desktop - desktop ERPC 句柄
 */
export const consumeDesktopPendingProjectOpen = (desktop: NonNullable<Desktop>) =>
	desktop.host.consumePendingProjectOpen.query()

/**
 * 尝试把指定桌面进程前置到最前。
 * @param desktop - desktop ERPC 句柄
 * @param pid - 目标进程 ID
 */
export const focusDesktopProcess = (desktop: NonNullable<Desktop>, pid: number) =>
	desktop.host.focusProcess.mutate({ pid })

/**
 * 通过 desktop 宿主选择目录。
 * @param desktop - desktop ERPC 句柄。
 * @param path - 当前默认目录。
 */
export const selectDesktopDirectory = async (desktop: NonNullable<Desktop>, path: string) => {
	const result = await desktop.host.selectDirectory.query({ path })
	return result.path
}

/**
 * 通过 desktop 宿主选择项目文件或目录。
 * @param desktop - desktop ERPC 句柄。
 * @param path - 当前默认路径。
 */
export const selectDesktopProjectPath = async (desktop: NonNullable<Desktop>, path: string) => {
	const result = await desktop.host.selectProjectPath.query({ path })
	return result.path
}
