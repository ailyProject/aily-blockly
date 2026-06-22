import { withProjectMutationLock } from '../lock'
import { getDeclaredBlocklyLibraryDependencies } from '../packageRules'
import { runProjectPackageManagerCommand } from './command'
import {
	assertBlocklyLibraryPackageName,
	assertProjectPackageJsonExists,
	getProjectPackageManagerCommand,
	readProjectPackageJsonData
} from './shared'

/**
 * 在当前项目目录安装一个 Blockly 库依赖。
 * @param input - 项目路径、库包名与目标版本
 */
export const installProjectBlocklyLibrary = async (input: {
	projectPath: string
	packageName: string
	version?: string
	localPath?: string
}) => {
	assertBlocklyLibraryPackageName(input.packageName)
	assertProjectPackageJsonExists(input.projectPath)

	const packageJson = await readProjectPackageJsonData(input.projectPath)
	const declaredDependencies = getDeclaredBlocklyLibraryDependencies(packageJson)
	const declaredVersion = declaredDependencies.get(input.packageName)
	const version = input.version?.trim() || declaredVersion || 'latest'
	const localPath = input.localPath?.trim()
	const packageSpec = localPath || `${input.packageName}@${version}`

	return withProjectMutationLock(input.projectPath, `install:${input.packageName}`, () =>
		runProjectPackageManagerCommand({
			projectPath: input.projectPath,
			command: getProjectPackageManagerCommand(),
			args: ['add', packageSpec],
			action: 'install',
			packageName: input.packageName,
			version,
			successMessage: localPath
				? `Installed ${input.packageName} from local path`
				: `Installed ${input.packageName}@${version}`
		})
	)
}
