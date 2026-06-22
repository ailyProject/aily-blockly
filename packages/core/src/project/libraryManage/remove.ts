import { withProjectMutationLock } from '../lock'
import { runProjectPackageManagerCommand } from './command'
import {
	assertBlocklyLibraryPackageName,
	assertProjectPackageJsonExists,
	getProjectPackageManagerCommand
} from './shared'

/**
 * 从当前项目目录移除一个 Blockly 库依赖。
 * @param input - 项目路径与库包名
 */
export const removeProjectBlocklyLibrary = async (input: { projectPath: string; packageName: string }) => {
	assertBlocklyLibraryPackageName(input.packageName)
	assertProjectPackageJsonExists(input.projectPath)

	return withProjectMutationLock(input.projectPath, `remove:${input.packageName}`, () =>
		runProjectPackageManagerCommand({
			projectPath: input.projectPath,
			command: getProjectPackageManagerCommand(),
			args: ['remove', input.packageName],
			action: 'remove',
			packageName: input.packageName,
			successMessage: `Removed ${input.packageName}`
		})
	)
}
