import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import type { ProjectNewCloudTemplate, ProjectNewTemplateSourceMode } from '../types'

/**
 * Project New 的模板选择卡片。
 */
@Component({
	selector: 'project-new-template-panel',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmInputImports],
	templateUrl: './template-panel.component.html',
	styleUrl: './template-panel.component.css'
})
export class ProjectNewTemplatePanelComponent {
	/** 当前模板来源模式。 */
	readonly templateSourceMode = input<ProjectNewTemplateSourceMode>('public')
	/** 当前 bearer token。 */
	readonly authToken = input('')
	/** 当前可用模板列表。 */
	readonly templates = input.required<Array<ProjectNewCloudTemplate>>()
	/** 当前选中的模板。 */
	readonly selectedTemplate = input<ProjectNewCloudTemplate | null>(null)
	/** 当前是否忙碌。 */
	readonly importBusy = input(false)
	/** 当前目标路径是否冲突。 */
	readonly pathConflict = input<boolean | null>(null)
	/** 当前名称校验消息。 */
	readonly nameValidationMessage = input<string | null>(null)
	/** 当前导入状态消息。 */
	readonly importMessage = input<string | null>(null)
	/** 选择模板来源模式。 */
	readonly templateSourceModeSelect = output<ProjectNewTemplateSourceMode>()
	/** 更新 bearer token。 */
	readonly authTokenChange = output<string>()
	/** 选择某个模板。 */
	readonly templateSelect = output<string>()
	/** 导入当前模板。 */
	readonly importTemplate = output<void>()

	/**
	 * 转发 token 输入。
	 * @param event - 输入事件
	 */
	protected updateAuthToken(event: Event) {
		this.authTokenChange.emit((event.target as HTMLInputElement).value)
	}
}
