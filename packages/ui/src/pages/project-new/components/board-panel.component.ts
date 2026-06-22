import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

/**
 * Project New 的板卡选择卡片。
 */
@Component({
	selector: 'project-new-board-panel',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './board-panel.component.html',
	styleUrl: './board-panel.component.css'
})
export class ProjectNewBoardPanelComponent {
	/** 当前选中的板卡展示名。 */
	readonly selectedBoardName = input('')
	/** 当前板卡是否存在公开示例。 */
	readonly hasExamples = input(false)
	/** 当前可选板卡列表。 */
	readonly boardOptions = input.required<Array<{ name: string; displayName: string }>>()
	/** 选择板卡。 */
	readonly boardSelect = output<string>()
}
