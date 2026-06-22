import type { LibManagerActionContext, LibManagerRegistryLibraryView } from './types'

/**
 * 在远程 registry 中搜索 Blockly 库。
 * @param input - 动作依赖与当前搜索词
 */
export const executeLibManagerRegistrySearch = async (input: {
	context: LibManagerActionContext
	query: string
	catalogNames: Array<string>
}) => {
	const query = input.query.trim()
	if (!query) {
		input.context.registrySearchResults.set([])
		return
	}

	input.context.registrySearchBusy.set(true)
	try {
		const result = await input.context.core.project.searchBlocklyLibraryRegistry.query({
			query,
			...(input.context.npmRegistry().trim() ? { registry: input.context.npmRegistry().trim() } : {}),
			limit: 12
		})
		const declaredNames = new Set(input.context.state()?.declaredLibraries.map(item => item.name) ?? [])
		const catalogNameSet = new Set(input.catalogNames)
		input.context.registrySearchResults.set(
			result.items
				.filter(item => !declaredNames.has(item.name))
				.filter(item => !catalogNameSet.has(item.name))
				.map(
					item =>
						({
							name: item.name,
							displayName: item.displayName,
							latestVersion: item.latestVersion,
							description: item.description,
							keywords: item.keywords || [],
							sourceLabel: 'registry'
						}) satisfies LibManagerRegistryLibraryView
				)
		)
	} catch (error) {
		input.context.statusMessage.set(error instanceof Error ? error.message : String(error))
	} finally {
		input.context.registrySearchBusy.set(false)
	}
}

/**
 * 加载指定库的版本列表。
 * @param input - 动作依赖与目标包名
 */
export const executeLibManagerLoadVersions = async (input: {
	context: LibManagerActionContext
	packageName: string
}) => {
	input.context.versionLoadingPackage.set(input.packageName)
	try {
		const result = await input.context.core.project.listBlocklyLibraryVersions.query({
			packageName: input.packageName,
			...(input.context.npmRegistry().trim() ? { registry: input.context.npmRegistry().trim() } : {})
		})
		input.context.libraryVersionsByPackage.update(current => ({
			...current,
			[input.packageName]: {
				registry: result.registry,
				latestVersion: result.latestVersion,
				versions: result.versions
			}
		}))
	} catch (error) {
		input.context.libraryVersionsByPackage.update(current => ({
			...current,
			[input.packageName]: {
				registry: input.context.npmRegistry().trim() || 'https://registry.npmjs.org',
				versions: [],
				error: error instanceof Error ? error.message : String(error)
			}
		}))
	} finally {
		input.context.versionLoadingPackage.set(null)
	}
}
