import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import type { GraphEditorSensorPickerGroup, GraphEditorState } from '../types'

/**
 * Graph Editor 的连线洞察卡片。
 */
@Component({
	selector: 'graph-editor-insights-card',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './insights-card.component.html',
	styleUrl: './insights-card.component.css'
})
export class GraphEditorInsightsCardComponent {
	readonly state = input.required<GraphEditorState>()
	readonly boards = input.required<Array<{ name: string; displayName: string }>>()
	readonly saveMessage = input<string | null>(null)
	readonly usePinmapId = output<string>()
	readonly usePinmapVariant = output<GraphEditorSensorPickerGroup['models'][number]['variants'][number]>()
}
