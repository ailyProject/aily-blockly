import type { AilyAppConfig, SerialMonitorConfig } from 'shared'

/**
 * 更新串口监视器配置。
 * @param config - 当前应用配置
 * @param serialMonitor - 新串口监视器配置
 */
export const setSerialMonitorConfig = (
	config: AilyAppConfig | null | undefined,
	serialMonitor: SerialMonitorConfig
): AilyAppConfig => ({
	...(config ?? {}),
	serialMonitor: {
		...(config?.serialMonitor ?? {}),
		...serialMonitor
	}
})
