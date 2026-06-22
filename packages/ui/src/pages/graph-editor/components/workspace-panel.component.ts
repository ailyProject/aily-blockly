import { Component, input, output } from '@angular/core'
import { HlmCardImports } from 'spartan/card'

import { GraphEditorEditorCardComponent } from './editor-card.component'
import { GraphEditorInsightsCardComponent } from './insights-card.component'

import type { GraphEditorSensorPickerGroup, GraphEditorState } from '../types'

/**
 * Graph Editor 的工作区资产卡片。
 */
@Component({
	selector: 'graph-editor-workspace-panel',
	imports: [GraphEditorEditorCardComponent, GraphEditorInsightsCardComponent, HlmCardImports],
	templateUrl: './workspace-panel.component.html',
	styleUrl: './workspace-panel.component.css'
})
export class GraphEditorWorkspacePanelComponent {
	readonly state = input.required<GraphEditorState>()
	readonly boards = input.required<Array<{ name: string; displayName: string }>>()
	readonly loading = input(false)
	readonly error = input<string | null>(null)
	readonly graphJson = input('')
	readonly graphJsonDirty = input(false)
	readonly graphJsonError = input<string | null>(null)
	readonly awsContent = input('')
	readonly awsDirty = input(false)
	readonly cloudAuthToken = input('')
	readonly pinmapHints = input.required<Array<string>>()
	readonly pinmapId = input('')
	readonly pinmapJson = input('')
	readonly pinmapJsonError = input<string | null>(null)
	readonly pinmapSaveBusy = input(false)
	readonly pinmapTemplateProtocol = input('i2c')
	readonly pinmapTemplateJson = input('')
	readonly syncBusy = input(false)
	readonly saveMessage = input<string | null>(null)
	readonly cloudAuthTokenChange = output<string>()
	readonly pinmapTemplateProtocolChange = output<string>()
	readonly pinmapIdChange = output<string>()
	readonly pinmapJsonChange = output<string>()
	readonly graphJsonChange = output<string>()
	readonly awsContentChange = output<string>()
	readonly usePinmapId = output<string>()
	readonly usePinmapVariant = output<GraphEditorSensorPickerGroup['models'][number]['variants'][number]>()
	readonly syncCloudPinmaps = output<void>()
	readonly savePinmap = output<void>()
	readonly saveGraph = output<void>()
	readonly saveAws = output<void>()

	protected updateCloudAuthToken(event: Event) {
		this.cloudAuthTokenChange.emit((event.target as HTMLInputElement).value)
	}

	protected updatePinmapTemplateProtocol(event: Event) {
		this.pinmapTemplateProtocolChange.emit((event.target as HTMLInputElement).value)
	}

	protected updatePinmapId(event: Event) {
		this.pinmapIdChange.emit((event.target as HTMLInputElement).value)
	}
}
