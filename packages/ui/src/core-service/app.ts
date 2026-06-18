import type { Core, LoadHomePreviewOptions } from './types'

/**
 * 聚合首页当前所需的 core.app / core.agent / core.hardware 调用。
 * @param core - core 句柄
 * @param options - 首页预览输入
 */
export const loadHomePreview = async (core: Core, options: LoadHomePreviewOptions) => {
	const [
		enabledModels,
		boardCategories,
		boardValidation,
		libraryValidation,
		securityOptions,
		appConfigSummary,
		appStoreSummary,
		previewConfig,
		defaultAppStore,
		mergedToolbarOrder,
		toggledLayout,
		resetLayout,
		serialConnect,
		recentProjects,
		recentModels,
		addedRecentProjects,
		removedRecentProjects,
		onboarding,
		previewOnboarding,
		addedRecentModelProjects,
		removedRecentModelProjects
	] = await Promise.all([
		core.agent.getEnabledModels.query({ config: options.agentConfig }),
		core.hardware.getBoardCategories.query({ boards: options.boardIndex, dimension: 'architecture' }),
		core.hardware.validateLegacyBoard.query({ boardName: 'esp32s3 xiao', boards: options.legacyBoards }),
		core.hardware.validateLegacyLibrary.query({ libraryName: 'rc522 reader', libraries: options.legacyLibraries }),
		core.agent.getSecurityOptions.query({ config: options.agentConfig }),
		core.app.get.query({ config: options.appConfig, fallbackLanguage: options.context.fallbackLanguage }),
		core.app.resolveLayout.query({
			config: options.appConfig,
			apps: options.toolbarApps,
			defaultToolbarAppIds: options.appConfig.toolbarAppIds ?? [],
			context: options.context
		}),
		core.app.previewUpdate.query({
			config: options.appConfig,
			...(options.mutationInput as object)
		}),
		core.app.createDefaultLayout.query({
			defaultToolbarAppIds: options.appConfig.toolbarAppIds ?? [],
			apps: options.toolbarApps
		}),
		core.app.mergeVisibleOrder.query({
			currentZoneIds: options.appConfig.toolbarAppIds ?? [],
			visibleIds: ['flash-fs', 'aily-chat'],
			visibleCatalogIds: options.toolbarApps.map(app => app.id)
		}),
		core.app.toggleApp.query({
			layout: {
				version: 2,
				zones: {
					header: options.appConfig.toolbarAppIds ?? []
				}
			},
			zone: 'header',
			appId: 'dev-tool',
			apps: options.toolbarApps
		}),
		core.app.reset.query({
			defaultToolbarAppIds: options.appConfig.toolbarAppIds ?? [],
			apps: options.toolbarApps
		}),
		core.app.buildSerialConnectOptions.query({
			config: options.appConfig,
			port: 'COM7'
		}),
		core.app.getRecentProjects.query({ config: options.appConfig }),
		core.app.getRecentModelProjects.query({ config: options.appConfig }),
		core.app.addRecentProject.query({
			config: options.appConfig,
			project: { name: 'Vision Station', path: '/Users/demo/projects/vision-station' }
		}),
		core.app.removeRecentProject.query({
			config: options.appConfig,
			projectPath: '/Users/demo/projects/robot-arm'
		}),
		core.app.getOnboarding.query({ config: options.appConfig }),
		core.app.completeOnboarding.query({
			config: options.appConfig,
			key: 'ailyChatOnboardingCompleted'
		}),
		core.app.addRecentModelProject.query({
			config: options.appConfig,
			project: {
				name: 'Fruit Classifier',
				path: '/Users/demo/projects/fruit-classifier',
				modelType: 'classification'
			}
		}),
		core.app.removeRecentModelProject.query({
			config: options.appConfig,
			projectPath: '/Users/demo/projects/fruit-classifier'
		})
	])

	const resolvedModel = await core.app.resolveModel.query({
		config: options.appConfig,
		enabledModels
	})

	return {
		enabledModels,
		boardCategories,
		boardValidation,
		libraryValidation,
		securityOptions,
		appConfigSummary,
		appStoreSummary,
		previewConfig,
		defaultAppStore,
		mergedToolbarOrder,
		toggledLayout,
		resetLayout,
		serialConnect,
		recentProjects,
		recentModels,
		addedRecentProjects,
		removedRecentProjects,
		onboarding,
		previewOnboarding,
		resolvedModel,
		addedRecentModelProjects,
		removedRecentModelProjects
	}
}
