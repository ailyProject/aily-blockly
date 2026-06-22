import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

/**
 * Project New 的基础配置卡片。
 */
@Component({
	selector: 'project-new-setup-panel',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmInputImports],
	templateUrl: './setup-panel.component.html',
	styleUrl: './setup-panel.component.css'
})
export class ProjectNewSetupPanelComponent {
	/** 当前项目名称。 */
	readonly projectName = input('')
	/** 当前项目名称校验提示。 */
	readonly nameValidationMessage = input<string | null>(null)
	/** 当前根目录。 */
	readonly rootPath = input('')
	/** 当前解析出的项目路径。 */
	readonly resolvedProjectPath = input('')
	/** 当前目标路径是否冲突。 */
	readonly pathConflict = input<boolean | null>(null)
	/** 当前是否正在创建/导入。 */
	readonly importBusy = input(false)
	/** 当前是否已有 desktop runtime。 */
	readonly runtimeAvailable = input(false)
	/** 当前项目是否允许直接创建。 */
	readonly canCreate = input(false)
	/** 重新加载页面。 */
	readonly reload = output<void>()
	/** 更新项目名称。 */
	readonly projectNameChange = output<string>()
	/** 选择根目录。 */
	readonly chooseRootFolder = output<void>()
	/** 请求建议可用名称。 */
	readonly suggestAvailableName = output<void>()
	/** 创建空白项目。 */
	readonly createBlankProject = output<void>()

	/**
	 * 转发项目名称输入。
	 * @param event - 输入事件
	 */
	protected updateProjectName(event: Event) {
		this.projectNameChange.emit((event.target as HTMLInputElement).value)
	}
}
