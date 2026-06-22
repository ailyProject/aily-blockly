/**
 * 读取配置中的 toolbar app id 列表。
 * @param config - 当前应用配置
 * @param storageKey - 配置存储键
 */
export const readToolbarAppIdsFromConfig = (config: Record<string, unknown> | null | undefined, storageKey: string) => {
	const value = config?.[storageKey]
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null
}
