import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import type { SerialMonitorPageState } from '../types'

/**
 * Serial Monitor 的连接配置卡片。
 */
@Component({
	selector: 'serial-monitor-connection-card',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './connection-card.component.html',
	styleUrl: './connection-card.component.css'
})
export class SerialMonitorConnectionCardComponent {
	readonly state = input.required<SerialMonitorPageState>()
	readonly busy = input(false)
	readonly choosePort = output<string>()
	readonly chooseBaudRate = output<string>()
}
