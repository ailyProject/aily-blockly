import { executeLibManagerLoadVersions, executeLibManagerRegistrySearch } from '../actions/registry'

import type { LibManagerActionContext } from '../../types'

/**
 * 执行当前搜索词对应的远程 registry 搜索。
 * @param input - 页面上下文、搜索词和当前 catalog 名单
 */
export const searchLibManagerRegistry = (input: {
	context: LibManagerActionContext
	query: string
	catalogNames: Array<string>
}) => executeLibManagerRegistrySearch(input)

/**
 * 加载指定库的版本列表。
 * @param input - 页面上下文与目标包名
 */
export const loadLibManagerVersions = (input: { context: LibManagerActionContext; packageName: string }) =>
	executeLibManagerLoadVersions({
		context: input.context,
		packageName: input.packageName
	})
