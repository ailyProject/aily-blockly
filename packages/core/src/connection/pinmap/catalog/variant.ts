import type { ConnectionPinmapConfig, ConnectionPinmapVariant } from '../../types'

const deriveVariantProtocol = (config: ConnectionPinmapConfig) => {
	const types = new Set<string>()

	for (const pin of config.pins || []) {
		if (pin.visible === false || pin.disabled === true) continue
		for (const fn of pin.functions || []) {
			if (fn.visible === false || fn.disabled === true) continue
			const type = fn.type.trim().toLowerCase()
			if (type && type !== 'power' && type !== 'gnd') types.add(type)
		}
	}

	for (const candidate of ['i2c', 'spi', 'uart', 'pwm', 'analog', 'digital']) {
		if (types.has(candidate)) return candidate
	}

	return types.size > 0 ? 'other' : undefined
}

const derivePreviewPins = (config: ConnectionPinmapConfig) => {
	const names: Array<string> = []

	for (const pin of config.pins || []) {
		if (pin.visible === false || pin.disabled === true) continue
		const firstVisible = pin.functions.find(fn => fn.visible !== false && fn.disabled !== true) || pin.functions[0]
		if (firstVisible?.name?.trim()) names.push(firstVisible.name.trim())
	}

	return names.length > 0 ? names : undefined
}

/**
 * 用 pinmap 配置补全 catalog 变体的协议和预览引脚信息。
 * @param variant - 当前 catalog 变体
 * @param config - 对应的 pinmap 配置
 */
export const enrichConnectionCatalogVariantFromConfig = (
	variant: ConnectionPinmapVariant,
	config?: ConnectionPinmapConfig
) => {
	if (!config) return

	const protocol = deriveVariantProtocol(config)
	const previewPins = derivePreviewPins(config)

	if (protocol) variant.protocol = protocol
	if (previewPins) {
		Object.assign(variant, {
			previewPins
		})
	}
}
