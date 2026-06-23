import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import type { AbsBlockArgOrderEntry, AbsBlockMeta } from './types'

interface BlockArgDefinition {
	type?: string
	name?: string
	output?: string | Array<string>
}

let globalBlockMetas: Map<string, AbsBlockMeta> | null = null

/**
 * 设置当前进程内共享的 block meta 缓存。
 * @param metas - 已加载的块元数据
 */
export const setGlobalBlockMetas = (metas: Map<string, AbsBlockMeta>) => {
	globalBlockMetas = metas
}

/**
 * 获取当前进程内共享的 block meta 缓存。
 */
export const getGlobalBlockMetas = () => globalBlockMetas

const categorizeArg = (arg: BlockArgDefinition, meta: AbsBlockMeta) => {
	if (!arg?.name) return

	const kind = arg.type || ''
	if (kind.startsWith('field_')) {
		meta.fieldNames.push(arg.name)
		meta.fieldTypes.set(arg.name, kind)
		meta.argsOrder.push({ name: arg.name, kind: 'field' })
		return
	}

	if (kind === 'input_value') {
		meta.valueInputNames.push(arg.name)
		meta.argsOrder.push({ name: arg.name, kind: 'valueInput' })
		return
	}

	if (kind === 'input_statement') {
		meta.statementInputNames.push(arg.name)
		meta.argsOrder.push({ name: arg.name, kind: 'statementInput' })
	}
}

const parseBlockDefinition = (definition: Record<string, unknown>, libraryDirName: string): AbsBlockMeta | null => {
	const type = typeof definition['type'] === 'string' ? definition['type'] : ''
	if (!type) return null

	const meta: AbsBlockMeta = {
		type,
		fieldNames: [],
		fieldTypes: new Map(),
		valueInputNames: [],
		statementInputNames: [],
		argsOrder: [],
		hasOutput: 'output' in definition,
		outputType: definition['output'] as string | Array<string> | undefined,
		hasPrevious: 'previousStatement' in definition,
		hasNext: 'nextStatement' in definition,
		isRootBlock: false,
		library: `@aily-project/${libraryDirName}`,
		...(typeof definition['mutator'] === 'string' ? { mutator: definition['mutator'] } : {})
	}

	if (!meta.hasPrevious && !meta.hasNext && !meta.hasOutput) {
		if (type.includes('arduino_') || type.includes('_setup') || type.includes('_loop')) {
			meta.isRootBlock = true
		}
	}

	for (let index = 0; index <= 10; index += 1) {
		const argsKey = index === 0 ? 'args0' : `args${index}`
		const args = definition[argsKey]
		if (!Array.isArray(args)) continue

		for (const arg of args as Array<BlockArgDefinition>) {
			categorizeArg(arg, meta)
		}
	}

	return meta
}

/**
 * 从项目 `node_modules/@aily-project/lib-*` 中同步加载块定义。
 * @param projectPath - 项目根目录
 */
export const loadBlockDefinitionsFromProjectPath = (projectPath: string): Map<string, AbsBlockMeta> => {
	const blocks = new Map<string, AbsBlockMeta>()
	const librariesRoot = path.join(projectPath, 'node_modules', '@aily-project')

	if (!existsSync(librariesRoot)) {
		return blocks
	}

	const entries = readdirSync(librariesRoot, { withFileTypes: true })
	const libraryDirs = entries.filter(entry => entry.isDirectory() && entry.name.startsWith('lib-'))

	for (const libraryDir of libraryDirs) {
		const blockJsonPath = path.join(librariesRoot, libraryDir.name, 'block.json')
		if (!existsSync(blockJsonPath)) continue

		try {
			const blockDefinitions = JSON.parse(readFileSync(blockJsonPath, 'utf8')) as Array<Record<string, unknown>>
			if (!Array.isArray(blockDefinitions)) continue

			for (const definition of blockDefinitions) {
				const meta = parseBlockDefinition(definition, libraryDir.name)
				if (meta) {
					blocks.set(meta.type, meta)
				}
			}
		} catch {
			continue
		}
	}

	return blocks
}

/**
 * 为指定项目刷新全局块元数据缓存。
 * @param projectPath - 项目根目录
 */
export const loadProjectBlockDefinitions = (projectPath: string) => {
	const metas = loadBlockDefinitionsFromProjectPath(projectPath)
	setGlobalBlockMetas(metas)
	return metas
}

/**
 * 构造 block type 到库包名的绑定表。
 * @param metas - 已加载的块元数据
 */
export const createBlockTypeLibraryBindings = (
	metas: Iterable<AbsBlockMeta>
): Record<string, { name: string; version: string; localPath?: string }> => {
	const bindings: Record<string, { name: string; version: string; localPath?: string }> = {}

	for (const meta of metas) {
		bindings[meta.type] = {
			name: meta.library,
			version: ''
		}
	}

	return bindings
}

export type { AbsBlockArgOrderEntry, AbsBlockMeta }
