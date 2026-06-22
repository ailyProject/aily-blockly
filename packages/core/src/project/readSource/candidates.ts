import path from 'node:path'

import { getProjectConfig } from '../packageJson'
import { readProjectSourcePackageJson } from './package'

/**
 * 判断传入源码是否包含可用于构建的有效内容。
 * @param sourceCode - 待检查的源码文本
 */
export const hasProjectSourceCode = (sourceCode: string | null | undefined) => Boolean(sourceCode?.trim())

/**
 * 构造当前项目可能的源码入口候选列表。
 * @param projectPath - 当前项目目录
 */
export const createProjectSourceCandidates = async (projectPath: string) => {
	const packageJson = await readProjectSourcePackageJson(projectPath)
	const projectName = packageJson?.name?.trim() || path.basename(projectPath)
	const projectConfig = getProjectConfig(packageJson)
	const configuredSketchName =
		typeof projectConfig['sketchName'] === 'string' && projectConfig['sketchName'].trim()
			? projectConfig['sketchName'].trim()
			: null

	return [
		{
			filePath: path.join(projectPath, '.temp', 'sketch', 'sketch.ino'),
			sourceKind: 'build-cache' as const
		},
		{
			filePath: path.join(projectPath, 'sketch.ino'),
			sourceKind: 'arduino-entry' as const
		},
		...(configuredSketchName
			? [
					{
						filePath: path.join(
							projectPath,
							configuredSketchName.endsWith('.ino') ? configuredSketchName : `${configuredSketchName}.ino`
						),
						sourceKind: 'arduino-entry' as const
					}
				]
			: []),
		{
			filePath: path.join(projectPath, `${projectName}.ino`),
			sourceKind: 'arduino-entry' as const
		},
		{
			filePath: path.join(projectPath, 'src', 'main.cpp'),
			sourceKind: 'cpp-entry' as const
		},
		{
			filePath: path.join(projectPath, 'main.py'),
			sourceKind: 'python-entry' as const
		}
	]
}
