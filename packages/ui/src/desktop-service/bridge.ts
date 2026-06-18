import { ENVIRONMENT_INITIALIZER, inject, makeEnvironmentProviders } from '@angular/core'

import { assignCoreServiceWindowConfig } from '../core-service/config'
import { DESKTOP } from './client'

import type { Desktop } from './types'

/**
 * 同步 desktop 侧 core service 地址到浏览器全局配置
 * @param desktop - desktop ERPC 句柄
 */
export const syncDesktopCoreServiceBridge = async (desktop: NonNullable<Desktop>) => {
	const status = await desktop.core.ensureCoreStarted.query()

	assignCoreServiceWindowConfig({
		host: status.address.host,
		port: status.address.port,
		baseUrl: status.address.baseUrl
	})

	return status
}

/**
 * 注册 desktop -> core 地址桥接初始化器
 */
export function provideDesktopCoreServiceBridge() {
	return makeEnvironmentProviders([
		{
			provide: ENVIRONMENT_INITIALIZER,
			multi: true,
			useValue: () => {
				const desktop = inject(DESKTOP)
				if (!desktop) return

				void syncDesktopCoreServiceBridge(desktop).catch(() => null)
			}
		}
	])
}
