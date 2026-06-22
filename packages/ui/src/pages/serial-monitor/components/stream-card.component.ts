import { Component, input, output } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import type { SerialSessionMessage } from '@core'
import type { SerialMonitorPageState } from '../types'

/**
 * Serial Monitor 的日志流卡片。
 */
@Component({
	selector: 'serial-monitor-stream-card',
	imports: [FormsModule, HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './stream-card.component.html',
	styleUrl: './stream-card.component.css'
})
export class SerialMonitorStreamCardComponent {
	readonly state = input.required<SerialMonitorPageState>()
	readonly messages = input.required<Array<SerialSessionMessage>>()
	readonly inputValue = input('')
	readonly busy = input(false)
	readonly inputValueChange = output<string>()
	readonly onInputKeydown = output<KeyboardEvent>()
	readonly toggleHexView = output<void>()
	readonly toggleTimestamp = output<void>()
	readonly toggleAutoScroll = output<void>()
	readonly clearMessages = output<void>()
	readonly toggleHexInput = output<void>()
	readonly toggleSendByEnter = output<void>()
	readonly toggleEndR = output<void>()
	readonly toggleEndN = output<void>()
	readonly send = output<void>()
}
