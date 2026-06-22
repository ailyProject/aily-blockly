import { Component, input, output } from '@angular/core'
import { HlmCardImports } from 'spartan/card'

import type { ProjectNewRecentItem } from '../types'

/**
 * Project New 的最近项目卡片。
 */
@Component({
	selector: 'project-new-recent-panel',
	imports: [HlmCardImports],
	templateUrl: './recent-panel.component.html',
	styleUrl: './recent-panel.component.css'
})
export class ProjectNewRecentPanelComponent {
	/** 最近项目列表。 */
	readonly recentProjects = input.required<Array<ProjectNewRecentItem>>()
	/** 选择某个最近项目。 */
	readonly projectSelect = output<ProjectNewRecentItem>()
}
