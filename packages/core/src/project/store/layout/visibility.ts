import type { AppRegistryItem, AppVisibilityContext } from 'shared'

const matchesAppCore = (appCore: string, currentCore: string) => {
	const normalizedAppCore = appCore.toLowerCase()
	return currentCore === normalizedAppCore || currentCore.split(':').includes(normalizedAppCore)
}

/**
 * 判断某个 app 在当前上下文中是否可见。
 * @param app - app 注册项
 * @param context - 当前可见性上下文
 */
export const isAppVisibleInContext = (app: AppRegistryItem, context: AppVisibilityContext = {}) => {
	if (app.enabled === false) return false
	if (app.dev && !context.isDevMode) return false

	if (app.router?.length && context.routeUrl) {
		const inRoute = app.router.some(route => context.routeUrl?.includes(route))
		if (!inRoute) return false
	}

	if (app.core?.length) {
		const currentCore = String(context.boardCore || '').toLowerCase()
		return app.core.some(core => matchesAppCore(core, currentCore))
	}

	return true
}
