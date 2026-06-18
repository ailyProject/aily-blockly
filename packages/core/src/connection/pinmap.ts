import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
	ConnectionPinmapCatalog,
	ConnectionPinmapConfig,
	ConnectionPinmapReference,
	ConnectionPinSummary,
	ConnectionPromptBundle
} from './types'

const systemPrompt = `You are an embedded hardware wiring assistant. Analyze board and peripheral pin definitions, then produce safe wiring plans in structured JSON.`

const userPromptTemplate = `Board and peripheral pin summaries:\n{{PIN_SUMMARY_JSON}}\n{{EXTRA_REQUIREMENTS}}`

/**
 * 解析 pinmapId。
 * @param {string} fullId - 完整 pinmapId
 * @returns {ConnectionPinmapReference}
 */
export const parsePinmapId = (fullId: string): ConnectionPinmapReference => {
	const parts = fullId.split(':')
	return {
		fullId,
		packageSlug: parts[0] || '',
		modelId: parts[1] || '',
		variantId: parts[2] || 'default'
	}
}

/**
 * 构建 pinmapId。
 * @param {string} packageSlug - 包标识
 * @param {string} modelId - 型号标识
 * @param {string} [variantId='default'] - 变体标识
 * @returns {string}
 */
export const buildPinmapId = (packageSlug: string, modelId: string, variantId = 'default') =>
	`${packageSlug}:${modelId}:${variantId || 'default'}`

/**
 * 读取组件配置文件。
 * @param {string} configPath - 配置文件路径
 * @returns {ConnectionPinmapConfig | null}
 */
export const readConnectionComponentConfig = (configPath: string): ConnectionPinmapConfig | null => {
	if (!existsSync(configPath)) return null

	try {
		return JSON.parse(readFileSync(configPath, 'utf8')) as ConnectionPinmapConfig
	} catch {
		return null
	}
}

/**
 * 提取引脚摘要。
 * @param {ConnectionPinmapConfig} config - 组件完整配置
 * @returns {ConnectionPinSummary}
 */
export const extractConnectionPinSummary = (config: ConnectionPinmapConfig): ConnectionPinSummary => {
	const pins = (config.pins || [])
		.filter(pin => pin.visible !== false && pin.disabled !== true)
		.map(pin => ({
			id: pin.id,
			functions: (pin.functions || [])
				.filter(fn => fn.visible !== false && fn.disabled !== true)
				.map(fn => ({ name: fn.name.trim(), type: fn.type }))
		}))

	return {
		componentId: config.id,
		componentName: config.name,
		pinCount: pins.length,
		pins
	}
}

/**
 * 解析 pinmap catalog 路径。
 * @param {string} packagePath - 包路径
 * @returns {string | null}
 */
export const resolveConnectionCatalogPath = (packagePath: string) => {
	const nestedPath = join(packagePath, 'pinmaps', 'pinmap_catalog.json')
	if (existsSync(nestedPath)) return nestedPath

	const legacyPath = join(packagePath, 'pinmap_catalog.json')
	return existsSync(legacyPath) ? legacyPath : null
}

/**
 * 读取 pinmap catalog。
 * @param {string} packagePath - 包路径
 * @returns {ConnectionPinmapCatalog | null}
 */
export const readConnectionPinmapCatalog = (packagePath: string): ConnectionPinmapCatalog | null => {
	const catalogPath = resolveConnectionCatalogPath(packagePath)
	if (!catalogPath) return null

	try {
		return JSON.parse(readFileSync(catalogPath, 'utf8')) as ConnectionPinmapCatalog
	} catch {
		return null
	}
}

/**
 * 解析开发板 pinmap 文件路径。
 * @param {string} boardPackagePath - 开发板包路径
 * @returns {string | null}
 */
export const resolveBoardPinmapPath = (boardPackagePath: string) => {
	const legacyPath = join(boardPackagePath, 'pinmap.json')
	if (existsSync(legacyPath)) return legacyPath

	const catalog = readConnectionPinmapCatalog(boardPackagePath)
	const model = catalog?.models?.[0]
	const variant =
		model?.variants.find(item => item.isDefault) ||
		model?.variants.find(item => item.status === 'available') ||
		model?.variants[0]

	if (!variant?.pinmapFile) return null

	const resolvedPath = join(boardPackagePath, variant.pinmapFile)
	return existsSync(resolvedPath) ? resolvedPath : null
}

/**
 * 读取开发板配置。
 * @param {string} boardPackagePath - 开发板包路径
 * @returns {ConnectionPinmapConfig | null}
 */
export const readBoardPinmapConfig = (boardPackagePath: string) => {
	const pinmapPath = resolveBoardPinmapPath(boardPackagePath)
	return pinmapPath ? readConnectionComponentConfig(pinmapPath) : null
}

/**
 * 读取开发板引脚摘要。
 * @param {string} boardPackagePath - 开发板包路径
 * @returns {ConnectionPinSummary | null}
 */
export const readBoardPinSummary = (boardPackagePath: string) => {
	const config = readBoardPinmapConfig(boardPackagePath)
	return config ? extractConnectionPinSummary(config) : null
}

/**
 * 扫描开发板目录下的外设配置文件。
 * @param {string} boardPackagePath - 开发板包路径
 * @returns {Array<string>}
 */
export const findPeripheralConfigPaths = (boardPackagePath: string) =>
	readdirSync(boardPackagePath)
		.filter(name => name.endsWith('_config.json') && name !== 'pinmap.json')
		.map(name => join(boardPackagePath, name))

/**
 * 解析 pinmap 文件路径。
 * @param {string} fullId - pinmapId
 * @param {string} packagesBasePath - 包基础目录
 * @returns {string | null}
 */
export const resolvePinmapPath = (fullId: string, packagesBasePath: string) => {
	const { packageSlug, modelId, variantId } = parsePinmapId(fullId)
	const packagePath = join(packagesBasePath, '@aily-project', packageSlug)
	if (!existsSync(packagePath)) return null

	const catalog = readConnectionPinmapCatalog(packagePath)
	if (!catalog) {
		const legacyPath = join(packagePath, 'pinmap.json')
		return existsSync(legacyPath) ? legacyPath : null
	}

	const model = catalog.models.find(item => item.id === modelId)
	const variant = model?.variants.find(item => item.id === variantId)
	if (!variant) return null

	if (variant.pinmapFile) return join(packagePath, variant.pinmapFile)
	if (variant.pinmapRef && catalog.sharedPinmaps?.[variant.pinmapRef]) {
		return join(packagePath, catalog.sharedPinmaps[variant.pinmapRef].file)
	}

	const legacyPath = join(packagePath, 'pinmap.json')
	return existsSync(legacyPath) ? legacyPath : null
}

/**
 * 通过 pinmapId 读取组件配置。
 * @param {string} fullId - pinmapId
 * @param {string} packagesBasePath - 包基础目录
 * @returns {ConnectionPinmapConfig | null}
 */
export const loadPinmapConfigById = (fullId: string, packagesBasePath: string) => {
	const configPath = resolvePinmapPath(fullId, packagesBasePath)
	return configPath ? readConnectionComponentConfig(configPath) : null
}

/**
 * 通过 pinmapId 读取引脚摘要。
 * @param {string} fullId - pinmapId
 * @param {string} packagesBasePath - 包基础目录
 * @returns {ConnectionPinSummary | null}
 */
export const loadPinSummaryById = (fullId: string, packagesBasePath: string) => {
	const config = loadPinmapConfigById(fullId, packagesBasePath)
	return config ? extractConnectionPinSummary(config) : null
}

/**
 * 生成完整引脚摘要。
 * @param {string} boardPackagePath - 开发板包路径
 * @param {Array<string>} [peripheralConfigPaths] - 外设配置路径列表
 * @returns {Array<ConnectionPinSummary>}
 */
export const generatePinSummaries = (boardPackagePath: string, peripheralConfigPaths?: Array<string>) => {
	const summaries: Array<ConnectionPinSummary> = []
	const boardSummary = readBoardPinSummary(boardPackagePath)
	if (boardSummary) summaries.push(boardSummary)

	for (const configPath of peripheralConfigPaths || findPeripheralConfigPaths(boardPackagePath)) {
		const config = readConnectionComponentConfig(configPath)
		if (config) summaries.push(extractConnectionPinSummary(config))
	}

	return summaries
}

/**
 * 构建 user prompt。
 * @param {Array<ConnectionPinSummary>} pinSummaries - 引脚摘要
 * @param {string} [extraRequirements] - 额外需求
 * @returns {string}
 */
export const buildConnectionUserPrompt = (pinSummaries: Array<ConnectionPinSummary>, extraRequirements?: string) =>
	userPromptTemplate
		.replace('{{PIN_SUMMARY_JSON}}', JSON.stringify(pinSummaries, null, 2))
		.replace('{{EXTRA_REQUIREMENTS}}', extraRequirements ? `Extra requirements:\n- ${extraRequirements}` : '')

/**
 * 构建完整 prompt。
 * @param {string} boardPackagePath - 开发板包路径
 * @param {Array<string>} [peripheralConfigPaths] - 外设配置路径列表
 * @param {string} [extraRequirements] - 额外需求
 * @returns {ConnectionPromptBundle}
 */
export const buildConnectionPrompt = (
	boardPackagePath: string,
	peripheralConfigPaths?: Array<string>,
	extraRequirements?: string
): ConnectionPromptBundle => {
	const pinSummaries = generatePinSummaries(boardPackagePath, peripheralConfigPaths)

	return {
		systemPrompt,
		userPrompt: buildConnectionUserPrompt(pinSummaries, extraRequirements),
		pinSummaries
	}
}
