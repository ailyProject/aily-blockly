import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parsePinmapId } from './id'

import type { ConnectionLibraryInfo } from '../types'

const trimLongText = (value: string, maxLength: number) =>
	value.length > maxLength ? `${value.slice(0, maxLength)}\n...(已截断)` : value

/**
 * 获取生成 pinmap 所需的库信息。
 * @param pinmapId - 完整 pinmapId
 * @param packagesBasePath - 包基础目录
 */
export const getConnectionLibraryInfo = (pinmapId: string, packagesBasePath: string): ConnectionLibraryInfo => {
	const ref = parsePinmapId(pinmapId)
	const packagePath = join(packagesBasePath, '@aily-project', ref.packageSlug)
	const result: ConnectionLibraryInfo = {}

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
