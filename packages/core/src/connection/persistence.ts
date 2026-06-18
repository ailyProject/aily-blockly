import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildPinmapId, parsePinmapId, readConnectionComponentConfig, readConnectionPinmapCatalog } from './pinmap'

import type { ConnectionPinmapCatalog, ConnectionPinmapConfig, ConnectionPinmapVariant } from './types'

const trimLongText = (value: string, maxLength: number) =>
	value.length > maxLength ? `${value.slice(0, maxLength)}\n...(已截断)` : value

const deriveVariantProtocol = (config: ConnectionPinmapConfig) => {
	const types = new Set<string>()

	for (const pin of config.pins || []) {
		if (pin.visible === false || pin.disabled === true) continue
		for (const fn of pin.functions || []) {
			if (fn.visible === false || fn.disabled === true) continue
			const type = fn.type.trim().toLowerCase()
			if (type && type !== 'power' && type !== 'gnd') types.add(type)
		}
	}

	for (const candidate of ['i2c', 'spi', 'uart', 'pwm', 'analog', 'digital']) {
		if (types.has(candidate)) return candidate
	}

	return types.size > 0 ? 'other' : undefined
}

const derivePreviewPins = (config: ConnectionPinmapConfig) => {
	const names: Array<string> = []

	for (const pin of config.pins || []) {
		if (pin.visible === false || pin.disabled === true) continue
		const firstVisible = pin.functions.find(fn => fn.visible !== false && fn.disabled !== true) || pin.functions[0]
		if (firstVisible?.name?.trim()) names.push(firstVisible.name.trim())
	}

	return names.length > 0 ? names : undefined
}

const enrichVariantFromConfig = (variant: ConnectionPinmapVariant, config?: ConnectionPinmapConfig) => {
	if (!config) return

	const protocol = deriveVariantProtocol(config)
	const previewPins = derivePreviewPins(config)

	if (protocol) variant.protocol = protocol
	if (previewPins) {
		Object.assign(variant, {
			previewPins
		})
	}
}

const createConnectionCatalog = (
	packageSlug: string,
	componentConfig?: ConnectionPinmapConfig
): ConnectionPinmapCatalog => ({
	version: '1.0.0',
	library: `@aily-project/${packageSlug}`,
	displayName: componentConfig?.name || `${packageSlug.replace('lib-', '').toUpperCase()} 系列`,
	type: 'library',
	models: []
})

const updateCatalogVariant = (input: {
	pinmapId: string
	status: 'available' | 'needs_generation'
	pinmapFile: string
	packagePath: string
	componentConfig?: ConnectionPinmapConfig
	catalogVersion?: string | number
}) => {
	const ref = parsePinmapId(input.pinmapId)
	const catalogPath = join(input.packagePath, 'pinmaps', 'pinmap_catalog.json')
	const existingCatalog = readConnectionPinmapCatalog(input.packagePath)
	const catalog = existingCatalog || createConnectionCatalog(ref.packageSlug, input.componentConfig)

	let model = catalog.models.find(item => item.id === ref.modelId)
	if (!model) {
		model = {
			id: ref.modelId,
			name: input.componentConfig?.name || ref.modelId.toUpperCase(),
			variants: []
		}
		catalog.models.push(model)
	}

	let variant = model.variants.find(item => item.id === ref.variantId)
	if (!variant) {
		variant = {
			id: ref.variantId,
			name: ref.variantId === 'default' ? '默认版本' : ref.variantId,
			fullId: input.pinmapId,
			status: input.status,
			pinmapFile: input.pinmapFile,
			isDefault: model.variants.length === 0
		}
		model.variants.push(variant)
	}

	variant.status = input.status
	variant.pinmapFile = input.pinmapFile
	enrichVariantFromConfig(variant, input.componentConfig)
	if (input.catalogVersion !== undefined) {
		Object.assign(variant, { version: input.catalogVersion })
	}

	writeFileSync(catalogPath, JSON.stringify(catalog, null, 2))
	return catalogPath
}

/**
 * 获取生成 pinmap 所需的库信息。
 * @param {string} pinmapId - 完整 pinmapId
 * @param {string} packagesBasePath - 包基础目录
 * @returns {{readme?: string, exampleCode?: string, packageJson?: unknown, existingPinmaps?: string[]}}
 */
export const getConnectionLibraryInfo = (pinmapId: string, packagesBasePath: string) => {
	const ref = parsePinmapId(pinmapId)
	const packagePath = join(packagesBasePath, '@aily-project', ref.packageSlug)
	const result: { readme?: string; exampleCode?: string; packageJson?: unknown; existingPinmaps?: Array<string> } = {}

	const readmePath = join(packagePath, 'README.md')
	if (existsSync(readmePath)) {
		result.readme = trimLongText(readFileSync(readmePath, 'utf8'), 4000)
	}

	const packageJsonPath = join(packagePath, 'package.json')
	if (existsSync(packageJsonPath)) {
		result.packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
	}

	const examplesDir = join(packagePath, 'examples')
	if (existsSync(examplesDir)) {
		const exampleFile = readdirSync(examplesDir).find(
			name => name.endsWith('.ino') || name.endsWith('.cpp') || name.endsWith('.c')
		)
		if (exampleFile) {
			result.exampleCode = trimLongText(readFileSync(join(examplesDir, exampleFile), 'utf8'), 2000)
		}
	}

	const pinmapsDir = join(packagePath, 'pinmaps')
	if (existsSync(pinmapsDir)) {
		result.existingPinmaps = readdirSync(pinmapsDir).filter(name => name.endsWith('.json'))
	}

	return result
}

/**
 * 获取 pinmap 配置模板。
 * @param {string} [protocol] - 协议类型
 * @returns {ConnectionPinmapConfig}
 */
export const getConnectionPinmapTemplate = (protocol?: string): ConnectionPinmapConfig => {
	const template: ConnectionPinmapConfig = {
		id: 'component_template',
		name: '传感器名称',
		width: 200,
		height: 100,
		images: [{ url: '组件图片的base64编码', x: 0, y: 0, width: 200, height: 100 }],
		pins: [],
		functionTypes: [
			{ value: 'power', label: '电源', color: '#EF4444', textColor: '#FFFFFF' },
			{ value: 'gnd', label: '接地', color: '#000000', textColor: '#FFFFFF' },
			{ value: 'digital', label: '数字', color: '#3B82F6', textColor: '#FFFFFF' },
			{ value: 'analog', label: '模拟', color: '#10B981', textColor: '#FFFFFF' },
			{ value: 'i2c', label: 'I2C', color: '#8B5CF6', textColor: '#FFFFFF' },
			{ value: 'spi', label: 'SPI', color: '#EC4899', textColor: '#FFFFFF' },
			{ value: 'uart', label: 'UART', color: '#F59E0B', textColor: '#FFFFFF' },
			{ value: 'pwm', label: 'PWM', color: '#06B6D4', textColor: '#FFFFFF' }
		]
	}

	const pinTemplates: Record<string, Array<ConnectionPinmapConfig['pins'][number]>> = {
		i2c: [
			{ id: 'pin_1', x: 10, y: 50, layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
			{ id: 'pin_2', x: 10, y: 70, layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
			{ id: 'pin_3', x: 10, y: 90, layout: 'horizontal', functions: [{ name: 'SDA', type: 'i2c' }] },
			{ id: 'pin_4', x: 190, y: 50, layout: 'horizontal', functions: [{ name: 'SCL', type: 'i2c' }] }
		],
		spi: [
			{ id: 'pin_1', x: 10, y: 30, layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
			{ id: 'pin_2', x: 10, y: 50, layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
			{ id: 'pin_3', x: 10, y: 70, layout: 'horizontal', functions: [{ name: 'MOSI', type: 'spi' }] },
			{ id: 'pin_4', x: 10, y: 90, layout: 'horizontal', functions: [{ name: 'MISO', type: 'spi' }] },
			{ id: 'pin_5', x: 190, y: 30, layout: 'horizontal', functions: [{ name: 'SCK', type: 'spi' }] },
			{ id: 'pin_6', x: 190, y: 50, layout: 'horizontal', functions: [{ name: 'CS', type: 'digital' }] }
		],
		uart: [
			{ id: 'pin_1', x: 10, y: 50, layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
			{ id: 'pin_2', x: 10, y: 70, layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
			{ id: 'pin_3', x: 10, y: 90, layout: 'horizontal', functions: [{ name: 'TX', type: 'uart' }] },
			{ id: 'pin_4', x: 190, y: 50, layout: 'horizontal', functions: [{ name: 'RX', type: 'uart' }] }
		]
	}

	template.pins = pinTemplates[protocol || ''] || [
		{ id: 'pin_1', x: 10, y: 50, layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
		{ id: 'pin_2', x: 10, y: 70, layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
		{ id: 'pin_3', x: 10, y: 90, layout: 'horizontal', functions: [{ name: 'DATA', type: 'digital' }] }
	]

	return template
}

/**
 * 保存 pinmap 配置并回写 catalog 状态。
 * @param {string} pinmapId - 完整 pinmapId
 * @param {ConnectionPinmapConfig} config - pinmap 配置
 * @param {string} packagesBasePath - 包基础目录
 * @param {string | number} [catalogVersion] - catalog 版本号
 * @returns {{success: boolean, filePath?: string, catalogPath?: string, resolvedPackagePath?: string, error?: string}}
 */
export const saveConnectionPinmapConfig = (
	pinmapId: string,
	config: ConnectionPinmapConfig,
	packagesBasePath: string,
	catalogVersion?: string | number
) => {
	try {
		const ref = parsePinmapId(pinmapId)
		const ailyProjectPath = join(packagesBasePath, '@aily-project')
		let packagePath = join(ailyProjectPath, ref.packageSlug)

		if (!existsSync(packagePath) && existsSync(ailyProjectPath)) {
			for (const packageName of readdirSync(ailyProjectPath)) {
				if (!packageName.startsWith(`${ref.packageSlug}-`) && packageName !== ref.packageSlug) continue
				const candidatePath = join(ailyProjectPath, packageName)
				const catalog = readConnectionPinmapCatalog(candidatePath)
				if (catalog?.models.some(model => model.id === ref.modelId) || !catalog) {
					packagePath = candidatePath
					break
				}
			}
		}

		if (!existsSync(packagePath)) {
			mkdirSync(packagePath, { recursive: true })
		}

		const pinmapsDir = join(packagePath, 'pinmaps')
		if (!existsSync(pinmapsDir)) {
			mkdirSync(pinmapsDir, { recursive: true })
		}

		const fileName = `${ref.modelId}_${ref.variantId}.json`
		const filePath = join(pinmapsDir, fileName)
		writeFileSync(filePath, JSON.stringify(config, null, 2))

		const catalogPath = updateCatalogVariant({
			pinmapId,
			status: 'available',
			pinmapFile: `pinmaps/${fileName}`,
			packagePath,
			componentConfig: config,
			catalogVersion
		})

		return {
			success: true,
			filePath,
			catalogPath,
			resolvedPackagePath: packagePath
		}
	} catch (error) {
		return {
			success: false,
			error: (error as Error).message
		}
	}
}
