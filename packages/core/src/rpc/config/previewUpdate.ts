import { z } from 'zod'

import {
	clearSkippedAppVersions,
	setAiChatMode,
	setDevmodeAutoSave,
	setDevmodeEnabled,
	setQuickSendList,
	setSelectedLanguage,
	setSerialMonitorConfig,
	setThemeMode,
	setToolbarAppIds,
	skipAppVersion
} from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput, quickSendItemSchema, serialMonitorSchema } from './schemas'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			versionToSkip: z.string().optional(),
			themeMode: z.enum(['dark', 'light']).optional(),
			aiChatMode: z.enum(['agent', 'ask']).optional(),
			selectedLanguage: z.string().optional(),
			devmodeEnabled: z.boolean().optional(),
			devmodeAutoSave: z.boolean().optional(),
			toolbarAppIds: z.array(z.string()).optional(),
			quickSendList: z.array(quickSendItemSchema).optional(),
			serialMonitor: serialMonitorSchema.optional(),
			clearSkippedVersions: z.boolean().optional()
		})
	)
	.query(({ input }) => {
		let nextConfig = normalizeAppConfigInput(input.config) ?? {}

		if (input.versionToSkip) nextConfig = skipAppVersion(nextConfig, input.versionToSkip)
		if (input.clearSkippedVersions) nextConfig = clearSkippedAppVersions(nextConfig)
		if (input.themeMode) nextConfig = setThemeMode(nextConfig, input.themeMode)
		if (input.aiChatMode) nextConfig = setAiChatMode(nextConfig, input.aiChatMode)
		if (input.selectedLanguage) nextConfig = setSelectedLanguage(nextConfig, input.selectedLanguage)
		if (typeof input.devmodeEnabled === 'boolean') nextConfig = setDevmodeEnabled(nextConfig, input.devmodeEnabled)
		if (typeof input.devmodeAutoSave === 'boolean') nextConfig = setDevmodeAutoSave(nextConfig, input.devmodeAutoSave)
		if (input.toolbarAppIds) nextConfig = setToolbarAppIds(nextConfig, input.toolbarAppIds)
		if (input.quickSendList) nextConfig = setQuickSendList(nextConfig, input.quickSendList)
		if (input.serialMonitor) nextConfig = setSerialMonitorConfig(nextConfig, input.serialMonitor)

		return nextConfig
	})
