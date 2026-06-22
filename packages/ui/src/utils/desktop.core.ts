import { assignCoreWindowConfig } from './core'
import { getDesktop } from './desktop.client'

import type { Desktop } from './desktop.types'

/**
 * 同步 desktop 侧 core 地址到浏览器全局配置。
 * @param desktop - desktop ERPC 句柄。
 */
export const syncDesktopCoreBridge = async (desktop: NonNullable<Desktop>) => {
	const status = await desktop.core.ensureCoreStarted.query()

	assignCoreWindowConfig({
		host: status.address.host,
		port: status.address.port,
		baseUrl: status.address.baseUrl
	})

	return status
}

/**
 * 在应用启动时尝试同步 desktop -> core 地址桥接。
 */
export const initializeDesktopCoreBridge = () => {
	const desktop = getDesktop()
	if (!desktop) return

	void syncDesktopCoreBridge(desktop).catch(() => null)
}
