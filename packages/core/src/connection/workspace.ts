import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { getSelectedBoardPackage } from '../project'
import { resolveConnectionGraphPaths } from './paths'
import { hasConnectionAws, hasConnectionGraph, readConnectionAws, readConnectionGraph } from './storage'

import type { ProjectPackageJson } from '../project'
import type { ConnectionWorkspaceState } from './types'

const readConnectionProjectPackage = (projectPath: string): ProjectPackageJson | null => {
	const packageJsonPath = path.join(projectPath, 'package.json')
	if (!existsSync(packageJsonPath)) return null

	try {
		return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as ProjectPackageJson
	} catch {
		return null
	}
}

/**
 * 汇总当前工程的连线资产状态。
 * @param projectPath - 项目根路径
 */
export const getConnectionWorkspaceState = (projectPath: string): ConnectionWorkspaceState => {
	const paths = resolveConnectionGraphPaths(projectPath)
	const graph = readConnectionGraph(projectPath)
	const awsContent = readConnectionAws(projectPath)
	const packagesBasePath = path.join(projectPath, 'node_modules')
	const boardPackageName = getSelectedBoardPackage(readConnectionProjectPackage(projectPath)) ?? ''

	return {
		packagesBasePath,
		boardPackageName,
		boardPackagePath: boardPackageName ? path.join(packagesBasePath, boardPackageName) : '',
		jsonPath: paths.jsonPath,
		awsPath: paths.awsPath,
		graphExists: hasConnectionGraph(projectPath),
		awsExists: hasConnectionAws(projectPath),
		graphDescription: graph?.description ?? '',
		componentCount: graph?.components.length ?? 0,
		connectionCount: graph?.connections.length ?? 0,
		awsLineCount: awsContent ? awsContent.split(/\r?\n/u).length : 0
	}
}
