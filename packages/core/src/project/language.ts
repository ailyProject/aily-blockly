/**
 * 把运行时 locale 归一化为项目内部使用的语言文件名。
 * @param language - 原始语言标识
 */
export const normalizeLanguageFileName = (language: string | null | undefined) => {
	if (!language) return 'zh_cn'

	const normalized = language.toLowerCase()

	if (normalized === 'zh-cn' || normalized === 'zh_cn') return 'zh_cn'
	if (normalized === 'zh-hk' || normalized === 'zh_hk') return 'zh_hk'
	if (normalized.startsWith('en_') || normalized.startsWith('en-')) return 'en'
	if (normalized.startsWith('fr_') || normalized.startsWith('fr-')) return 'fr'
	if (normalized.startsWith('de_') || normalized.startsWith('de-')) return 'de'
	if (normalized.startsWith('pt_') || normalized.startsWith('pt-')) return 'pt'

	return normalized
}
