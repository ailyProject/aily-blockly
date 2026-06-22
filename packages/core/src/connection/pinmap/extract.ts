import type { ConnectionPinmapConfig, ConnectionPinSummary } from '../types'

/**
 * 提取引脚摘要。
 * @param config - 组件完整配置
 */
export const extractConnectionPinSummary = (config: ConnectionPinmapConfig): ConnectionPinSummary => {
	const pins = (config.pins || [])
		.filter(pin => pin.visible !== false && pin.disabled !== true)
		.map(pin => ({
			id: pin.id,
			functions: (pin.functions || [])
				.filter(fn => fn.visible !== false && fn.disabled !== true)
				.map(fn => ({ name: fn.name.trim(), type: fn.type }))
		}))

	return {
		componentId: config.id,
		componentName: config.name,
		pinCount: pins.length,
		pins
	}
}
