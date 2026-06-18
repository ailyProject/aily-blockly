import type { Desktop } from './types'

/**
 * 从 desktop 宿主读取运行时信息。
 * @param {NonNullable<Desktop>} desktop - desktop ERPC 句柄
 * @returns {Promise<Awaited<ReturnType<NonNullable<Desktop>['host']['getRuntimeInfo']['query']>>>}
 */
export const loadDesktopHostRuntimeInfo = (desktop: NonNullable<Desktop>) => desktop.host.getRuntimeInfo.query()
