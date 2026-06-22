import type { ConnectionPinmapReference } from '../types'

/**
 * 解析 pinmapId。
 * @param fullId - 完整 pinmapId
 */
export const parsePinmapId = (fullId: string): ConnectionPinmapReference => {
	const parts = fullId.split(':')
	return {
		fullId,
		packageSlug: parts[0] || '',
		modelId: parts[1] || '',
		variantId: parts[2] || 'default'
	}
}

/**
 * 构建 pinmapId。
 * @param packageSlug - 包标识
 * @param modelId - 型号标识
 * @param variantId - 变体标识
 */
export const buildPinmapId = (packageSlug: string, modelId: string, variantId = 'default') =>
	`${packageSlug}:${modelId}:${variantId || 'default'}`
