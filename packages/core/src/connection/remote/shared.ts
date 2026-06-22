import { parsePinmapId, readConnectionPinmapCatalog } from '../pinmap'

/**
 * 根据本地包目录和 pinmap 提示，筛出需要拉取云端 pinmap 的目标包。
 * @param packageDirs - `@aily-project` 下的本地包目录名列表
 * @param pinmapIdHints - 上层传入的 pinmapId 提示
 */
export const resolveRemoteTargetLibraries = (packageDirs: Array<string>, pinmapIdHints?: Array<string>) => {
	const hinted = new Set<string>()
	for (const id of pinmapIdHints || []) {
		const { packageSlug } = parsePinmapId(id)
		if (packageSlug) hinted.add(packageSlug)
	}

	const allLibs = packageDirs.filter(name => name.startsWith('lib-'))
	const allBoards = packageDirs.filter(name => name.startsWith('board-'))
	return hinted.size > 0
		? Array.from(new Set([...allLibs.filter(name => hinted.has(name)), ...allBoards]))
		: [...allLibs, ...allBoards]
}

/**
 * 判断云端变体是否与当前本地 catalog 版本一致，从而跳过同步。
 * @param args - 本地目录、pinmapId 与云端版本
 */
export const shouldSkipCloudVariant = (args: {
	ailyRoot: string
	pinmapId: string
	cloudVersion?: string | number
}) => {
	if (args.cloudVersion === undefined) return false

	const { packageSlug, modelId, variantId } = parsePinmapId(args.pinmapId)
	const catalog = readConnectionPinmapCatalog(`${args.ailyRoot}/${packageSlug}`)
	const existingVariant = catalog?.models
		.find(model => model.id === modelId)
		?.variants.find(variant => variant.id === variantId) as { version?: string | number } | undefined

	return (
		existingVariant?.version !== undefined &&
		String(existingVariant.version).trim() === String(args.cloudVersion).trim()
	)
}
