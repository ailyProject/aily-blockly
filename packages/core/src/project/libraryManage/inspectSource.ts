import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { isBlocklyLibraryPackageName } from '../packageRules'

import type { ProjectBlocklyLibrarySourceInspection } from '../types'

const BLOCKLY_LIBRARY_REQUIRED_FILES = ['package.json', 'block.json', 'generator.js', 'toolbox.json']

/**
 * 检查本地目录是否可作为 Blockly 库导入。
 * @param localPath - 用户选择的本地目录
 */
export const inspectProjectBlocklyLibrarySource = (localPath: string): ProjectBlocklyLibrarySourceInspection => {
	const normalizedPath = path.resolve(localPath)
	if (!normalizedPath.trim()) {
		return {
			valid: false,
			localPath: normalizedPath,
			error: 'Local library path is empty.'
		}
	}

	if (!existsSync(normalizedPath)) {
		return {
			valid: false,
			localPath: normalizedPath,
			error: `Library path does not exist: ${normalizedPath}`
		}
	}

	if (!statSync(normalizedPath).isDirectory()) {
		return {
			valid: false,
			localPath: normalizedPath,
			error: `Library path is not a directory: ${normalizedPath}`
		}
	}

	const missingFiles = BLOCKLY_LIBRARY_REQUIRED_FILES.filter(
		fileName => !existsSync(path.join(normalizedPath, fileName))
	)
	if (missingFiles.length > 0) {
		return {
			valid: false,
			localPath: normalizedPath,
			missingFiles,
			error: `Missing required Blockly library files: ${missingFiles.join(', ')}`
		}
	}

	try {
		const packageJson = JSON.parse(readFileSync(path.join(normalizedPath, 'package.json'), 'utf8')) as {
			name?: string
			displayName?: string
			description?: string
		}
		const packageName = String(packageJson.name || '').trim()
		if (!isBlocklyLibraryPackageName(packageName)) {
			return {
				valid: false,
				localPath: normalizedPath,
				packageName,
				error: `Unsupported Blockly library package: ${packageName || '(empty package name)'}`
			}
		}

		return {
			valid: true,
			localPath: normalizedPath,
			packageName,
			displayName: packageJson.displayName?.trim() || packageName,
			description: packageJson.description?.trim() || undefined
		}
	} catch (error) {
		return {
			valid: false,
			localPath: normalizedPath,
			error: error instanceof Error ? error.message : String(error)
		}
	}
}
