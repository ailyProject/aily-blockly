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
		configSummary,
		storeSummary,
		previewConfig,
		defaultStore,
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
		core.config.get.query({ config: options.config, fallbackLanguage: options.context.fallbackLanguage }),
		core.store.resolveLayout.query({
			config: options.config,
			apps: options.toolbarApps,
			defaultToolbarAppIds: options.config.toolbarAppIds ?? [],
			context: options.context
		}),
		core.config.previewUpdate.query({
			config: options.config,
			...(options.mutationInput as object)
		}),
		core.store.createDefaultLayout.query({
			defaultToolbarAppIds: options.config.toolbarAppIds ?? [],
			apps: options.toolbarApps
		}),
		core.store.mergeVisibleOrder.query({
			currentZoneIds: options.config.toolbarAppIds ?? [],
			visibleIds: ['flash-fs', 'aily-chat'],
			visibleCatalogIds: options.toolbarApps.map(app => app.id)
		}),
		core.store.toggleApp.query({
			layout: {
				version: 2,
				zones: {
					header: options.config.toolbarAppIds ?? []
				}
			},
			zone: 'header',
			appId: 'dev-tool',
			apps: options.toolbarApps
		}),
		core.store.reset.query({
			defaultToolbarAppIds: options.config.toolbarAppIds ?? [],
			apps: options.toolbarApps
		}),
		core.config.buildSerialConnectOptions.query({
			config: options.config,
			port: 'COM7'
		}),
		core.project.getRecentProjects.query({ config: options.config }),
		core.project.getRecentModelProjects.query({ config: options.config }),
		core.project.addRecentProject.query({
			config: options.config,
			project: { name: 'Vision Station', path: '/Users/workspace/projects/vision-station' }
		}),
		core.project.removeRecentProject.query({
			config: options.config,
			projectPath: '/Users/workspace/projects/robot-arm'
		}),
		core.onboarding.getOnboarding.query({ config: options.config }),
		core.onboarding.completeOnboarding.query({
			config: options.config,
			key: 'ailyChatOnboardingCompleted'
		}),
		core.project.addRecentModelProject.query({
			config: options.config,
			project: {
				name: 'Fruit Classifier',
				path: '/Users/workspace/projects/fruit-classifier',
				modelType: 'classification'
			}
		}),
		core.project.removeRecentModelProject.query({
			config: options.config,
			projectPath: '/Users/workspace/projects/fruit-classifier'
		})
	])

	const resolvedModel = await core.config.resolveModel.query({
		config: options.config,
		enabledModels
	})

	return {
		enabledModels,
		boardCategories,
		boardValidation,
		libraryValidation,
		securityOptions,
		configSummary,
		storeSummary,
		previewConfig,
		defaultStore,
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
