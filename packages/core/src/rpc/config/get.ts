import { z } from 'zod'

import {
	getAiChatMode,
	getAppDataPathTemplate,
	getBlocklyThemeId,
	getDefaultSerialMonitorInputMode,
	getDefaultSerialMonitorViewMode,
	getMermaidTheme,
	getMonacoTheme,
	getQuickSendList,
	getSelectedLanguage,
	getSkippedVersions,
	getThemeMode,
	getToolbarAppIds,
	isDevmodeEnabled,
	resolveAppDataPath,
	resolveDevmodeConfig,
	resolveSerialMonitorConfig
} from '../../project'
import { p } from '../trpc'
import { appSchema, normalizeAppConfigInput } from './schemas'

import type { ConfigSummary } from './types'

export default p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			fallbackLanguage: z.string().optional(),
			userHome: z.string().optional()
		})
	)
	.query(({ input }): ConfigSummary => {
		const config = normalizeAppConfigInput(input.config)
		return {
			selectedLanguage: getSelectedLanguage(config, input.fallbackLanguage),
			themeMode: getThemeMode(config),
			monacoTheme: getMonacoTheme(config),
			mermaidTheme: getMermaidTheme(config),
			blocklyThemeId: getBlocklyThemeId(config),
			devmodeEnabled: isDevmodeEnabled(config),
			devmode: resolveDevmodeConfig(config),
			appDataPathTemplate: getAppDataPathTemplate(config),
			appDataPath: input.userHome ? resolveAppDataPath(config, input.userHome) : '',
			toolbarAppIds: getToolbarAppIds(config),
			skippedVersions: getSkippedVersions(config),
			aiChatMode: getAiChatMode(config),
			quickSendList: getQuickSendList(config),
			serialMonitor: resolveSerialMonitorConfig(config),
			serialViewMode: getDefaultSerialMonitorViewMode(),
			serialInputMode: getDefaultSerialMonitorInputMode()
		}
	})
