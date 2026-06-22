import { Component, input, output } from '@angular/core'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import type { QuickSendItem } from 'shared'

/**
 * Serial Monitor 的快捷发送卡片。
 */
@Component({
	selector: 'serial-monitor-quick-send-card',
	imports: [HlmButtonImports, HlmCardImports],
	templateUrl: './quick-send-card.component.html',
	styleUrl: './quick-send-card.component.css'
})
export class SerialMonitorQuickSendCardComponent {
	/** 快捷发送项列表。 */
	readonly quickSendList = input.required<Array<QuickSendItem>>()
	/** 当前串口是否已连接。 */
	readonly connected = input(false)
	/** 当前页面是否忙碌。 */
	readonly busy = input(false)
	/** 触发某个快捷发送动作。 */
	readonly quickSend = output<QuickSendItem>()
}
