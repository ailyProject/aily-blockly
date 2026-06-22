import { getQuickSendList, getToolbarAppIds } from '../selectors'

import type { AilyAppConfig, QuickSendItem } from 'shared'

/**
 * 更新 toolbar app id 列表。
 * @param config - 当前应用配置
 * @param toolbarAppIds - 新 toolbar app id 列表
 */
export const setToolbarAppIds = (
	config: AilyAppConfig | null | undefined,
	toolbarAppIds: Array<string>
): AilyAppConfig => ({
	...(config ?? {}),
	toolbarAppIds: getToolbarAppIds({ toolbarAppIds })
})

/**
 * 更新快速发送列表。
 * @param config - 当前应用配置
 * @param quickSendList - 新快速发送列表
 */
export const setQuickSendList = (
	config: AilyAppConfig | null | undefined,
	quickSendList: Array<QuickSendItem>
): AilyAppConfig => ({
	...(config ?? {}),
	quickSendList: getQuickSendList({ quickSendList })
})
