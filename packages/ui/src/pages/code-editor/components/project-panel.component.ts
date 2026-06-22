import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import type { CodeEditorProjectItem } from '../types'

/**
 * Code Editor 的项目选择卡片。
 */
@Component({
	selector: 'code-editor-project-panel',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmInputImports],
	templateUrl: './project-panel.component.html',
	styleUrl: './project-panel.component.css'
})
export class CodeEditorProjectPanelComponent {
	/** 最近项目列表。 */
	readonly recentProjects = input.required<Array<CodeEditorProjectItem>>()
	/** 当前项目路径。 */
	readonly projectPath = input('')
	/** 当前最近一次构建是否失败。 */
	readonly buildFailed = input(false)
	/** 当前是否存在生命周期重载提示。 */
	readonly projectReloadMessage = input<string | null>(null)
	/** 当前是否正在刷新项目状态。 */
	readonly projectReloadBusy = input(false)
	/** 项目路径输入变更。 */
	readonly projectPathChange = output<string>()
	/** 从最近项目中选择目标工程。 */
	readonly projectSelect = output<string>()
	/** 请求重新加载当前项目状态。 */
	readonly reloadProjectState = output<void>()

	/**
	 * 转发项目路径输入。
	 * @param event - 输入事件
	 */
	protected updateProjectPath(event: Event) {
		this.projectPathChange.emit((event.target as HTMLInputElement).value)
	}

	/**
	 * 转发最近项目选择。
	 * @param projectPath - 被选中的项目路径
	 */
	protected chooseProject(projectPath: string) {
		this.projectSelect.emit(projectPath)
	}
}
