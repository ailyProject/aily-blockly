import {
	chooseProjectOpenDirectory,
	formatProjectOpenConflictMessage,
	loadProjectOpenLifecycle,
	resolveProjectOpenSelection,
	resolveProjectOpenSessionConflict
} from './runtime'

import type { RecentlyProjectEntry } from 'shared'
import type { ProjectOpenActionContext } from './component.actions.types'

/**
 * 创建 Project Open 的选择与预览动作。
 * @param input - 页面依赖与状态
 */
export const createProjectOpenPreviewActions = (input: ProjectOpenActionContext) => ({
	async pruneRecentProject(projectPath: string) {
		input.state.recentProjects.update(projects => projects.filter(project => project.path !== projectPath))
		if (input.state.runtimeInfo()?.appDataPath) {
			await input.core.project.removeStoredRecentProject
				.mutate({
					appDataPath: input.state.runtimeInfo()!.appDataPath,
					projectPath
				})
				.catch(() => null)
		}
	},
	async chooseProjectPath() {
		const nextPath = await chooseProjectOpenDirectory(
			input.desktop,
			input.state.selectedPath(),
			input.selectDesktopProjectPath
		)
		if (!nextPath) return
		input.state.selectedPath.set(nextPath)
		await this.previewSelectedPath()
	},
	async useRecentProject(project: RecentlyProjectEntry) {
		input.state.selectedPath.set(project.path)
		await this.previewSelectedPath()
	},
	async previewSelectedPath() {
		const inputPath = input.state.selectedPath().trim()
		if (!inputPath) return

		input.state.statusMessage.set(null)
		input.state.resolvedProjectPath.set('')
		input.state.previewLifecycle.set(null)
		input.state.openSessionConflict.set(null)

		try {
			const projectPath = await resolveProjectOpenSelection(input.core, inputPath)
			if (!projectPath) {
				await this.pruneRecentProject(inputPath)
				input.state.statusMessage.set('Selected path could not be resolved to a project directory.')
				return
			}
			input.state.resolvedProjectPath.set(projectPath)

			const lifecycle = await loadProjectOpenLifecycle(input.core, projectPath)
			input.state.previewLifecycle.set(lifecycle)
			if (!lifecycle.hasPackageJson) {
				await this.pruneRecentProject(projectPath)
				input.state.statusMessage.set('Resolved directory is missing package.json.')
				return
			}
			const conflict = resolveProjectOpenSessionConflict(projectPath, lifecycle, input.state.runtimeInfo()?.pid)
			if (conflict) {
				input.state.openSessionConflict.set(conflict)
				input.state.statusMessage.set(formatProjectOpenConflictMessage(conflict.owner))
				return
			}

			const fragments = [`Ready to open via ${lifecycle.editorRoute}`]
			if (lifecycle.recoveredFromTemp) {
				fragments.push('recovered from temp snapshot')
			}
			if (lifecycle.parseError) {
				fragments.push(`primary ABI parse failed: ${lifecycle.parseError}`)
			}
			input.state.statusMessage.set(fragments.join(' | '))
		} catch (error) {
			input.state.statusMessage.set(error instanceof Error ? error.message : String(error))
		}
	}
})
