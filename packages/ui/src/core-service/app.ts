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
		core.config.get.query({ config: options.appConfig, fallbackLanguage: options.context.fallbackLanguage }),
		core.store.resolveLayout.query({
			config: options.appConfig,
			apps: options.toolbarApps,
			defaultToolbarAppIds: options.appConfig.toolbarAppIds ?? [],
			context: options.context
		}),
		core.config.previewUpdate.query({
			config: options.appConfig,
			...(options.mutationInput as object)
		}),
		core.store.createDefaultLayout.query({
			defaultToolbarAppIds: options.appConfig.toolbarAppIds ?? [],
			apps: options.toolbarApps
		}),
		core.store.mergeVisibleOrder.query({
			currentZoneIds: options.appConfig.toolbarAppIds ?? [],
			visibleIds: ['flash-fs', 'aily-chat'],
			visibleCatalogIds: options.toolbarApps.map(app => app.id)
		}),
		core.store.toggleApp.query({
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
		core.store.reset.query({
			defaultToolbarAppIds: options.appConfig.toolbarAppIds ?? [],
			apps: options.toolbarApps
		}),
		core.config.buildSerialConnectOptions.query({
			config: options.appConfig,
			port: 'COM7'
		}),
		core.project.getRecentProjects.query({ config: options.appConfig }),
		core.project.getRecentModelProjects.query({ config: options.appConfig }),
		core.project.addRecentProject.query({
			config: options.appConfig,
			project: { name: 'Vision Station', path: '/Users/demo/projects/vision-station' }
		}),
		core.project.removeRecentProject.query({
			config: options.appConfig,
			projectPath: '/Users/demo/projects/robot-arm'
		}),
		core.onboarding.getOnboarding.query({ config: options.appConfig }),
		core.onboarding.completeOnboarding.query({
			config: options.appConfig,
			key: 'ailyChatOnboardingCompleted'
		}),
		core.project.addRecentModelProject.query({
			config: options.appConfig,
			project: {
				name: 'Fruit Classifier',
				path: '/Users/demo/projects/fruit-classifier',
				modelType: 'classification'
			}
		}),
		core.project.removeRecentModelProject.query({
			config: options.appConfig,
			projectPath: '/Users/demo/projects/fruit-classifier'
		})
	])

	const resolvedModel = await core.config.resolveModel.query({
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
