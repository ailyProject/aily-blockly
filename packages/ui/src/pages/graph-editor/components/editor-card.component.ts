import { Component, input, output } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import type { GraphEditorState } from '../types'

/**
 * Graph Editor 的编辑器卡片。
 */
@Component({
	selector: 'graph-editor-editor-card',
	imports: [FormsModule, HlmButtonImports, HlmCardImports, HlmInputImports],
	templateUrl: './editor-card.component.html',
	styleUrl: './editor-card.component.css'
})
export class GraphEditorEditorCardComponent {
	readonly state = input.required<GraphEditorState>()
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
	readonly cloudAuthTokenChange = output<string>()
	readonly pinmapTemplateProtocolChange = output<string>()
	readonly pinmapIdChange = output<string>()
	readonly pinmapJsonChange = output<string>()
	readonly graphJsonChange = output<string>()
	readonly awsContentChange = output<string>()
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
