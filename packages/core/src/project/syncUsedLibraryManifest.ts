import { AILY_BLOCKLY_USED_LIBRARIES_FIELD } from 'shared'

import { createBlockTypeLibraryBindings, loadBlockDefinitionsFromProjectPath } from '../abs/blockMeta'
import { buildUsedLibraryManifest, normalizeUsedLibraryManifest } from '../metadata'
import { readProjectPackageJson } from './readPackageJson'
import { writeProjectPackageJson } from './writePackageJson'

import type { BlocklyProjectDocument } from '../document'

/**
 * 根据当前项目文档同步 package.json 中的 used-library manifest。
 * @param projectPath - 项目根目录
 * @param document - 当前归一化项目文档
 */
export const syncProjectUsedLibraryManifest = async (projectPath: string, document: BlocklyProjectDocument) => {
	const packageJson = await readProjectPackageJson(projectPath)
	if (!packageJson) return null

	const blockMetas = loadBlockDefinitionsFromProjectPath(projectPath)
	if (blockMetas.size === 0) return normalizeUsedLibraryManifest(packageJson[AILY_BLOCKLY_USED_LIBRARIES_FIELD])

	const previousManifest = normalizeUsedLibraryManifest(packageJson[AILY_BLOCKLY_USED_LIBRARIES_FIELD])
	const nextManifest = buildUsedLibraryManifest(
		document,
		createBlockTypeLibraryBindings(blockMetas.values()),
		packageJson,
		previousManifest
	)

	if (JSON.stringify(previousManifest) === JSON.stringify(nextManifest)) {
		return nextManifest
	}

	await writeProjectPackageJson(projectPath, {
		...packageJson,
		[AILY_BLOCKLY_USED_LIBRARIES_FIELD]: nextManifest
	})

	return nextManifest
}
