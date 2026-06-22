import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import type { SerialMonitorUploadResultView } from '../types'

/**
 * Serial Monitor 的上传结果卡片。
 */
@Component({
	selector: 'serial-monitor-upload-card',
	imports: [HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './upload-card.component.html',
	styleUrl: './upload-card.component.css'
})
export class SerialMonitorUploadCardComponent {
	/** 当前上传结果。 */
	readonly uploadResult = input.required<SerialMonitorUploadResultView>()
	/** 当前连接端口。 */
	readonly currentPort = input('')
	/** 当前页面是否忙碌。 */
	readonly busy = input(false)
	/** 请求重连串口。 */
	readonly reconnect = output<void>()
	/** 请求刷新端口列表。 */
	readonly refresh = output<void>()
	/** 请求重试上传。 */
	readonly retryUpload = output<void>()
}
