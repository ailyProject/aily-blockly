import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import type { GraphEditorState } from '../types'

/**
 * Graph Editor 的嵌入视图卡片。
 */
@Component({
	selector: 'graph-editor-frame-panel',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './frame-panel.component.html',
	styleUrl: './frame-panel.component.css'
})
export class GraphEditorFramePanelComponent {
	/** 当前 graph editor 聚合状态。 */
	readonly state = input.required<GraphEditorState>()
	/** desktop 桥是否可用。 */
	readonly desktopAvailable = input(false)
	/** 选择项目目录。 */
	readonly chooseProjectPath = output<void>()
}
