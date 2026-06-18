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
import { appSchema } from './schemas'

export const get = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			fallbackLanguage: z.string().optional(),
			userHome: z.string().optional()
		})
	)
	.query(({ input }) => ({
		selectedLanguage: getSelectedLanguage(input.config, input.fallbackLanguage),
		themeMode: getThemeMode(input.config),
		monacoTheme: getMonacoTheme(input.config),
		mermaidTheme: getMermaidTheme(input.config),
		blocklyThemeId: getBlocklyThemeId(input.config),
		devmodeEnabled: isDevmodeEnabled(input.config),
		devmode: resolveDevmodeConfig(input.config),
		appDataPathTemplate: getAppDataPathTemplate(input.config),
		appDataPath: input.userHome ? resolveAppDataPath(input.config, input.userHome) : '',
		toolbarAppIds: getToolbarAppIds(input.config),
		skippedVersions: getSkippedVersions(input.config),
		aiChatMode: getAiChatMode(input.config),
		quickSendList: getQuickSendList(input.config),
		serialMonitor: resolveSerialMonitorConfig(input.config),
		serialViewMode: getDefaultSerialMonitorViewMode(),
		serialInputMode: getDefaultSerialMonitorInputMode()
	}))
