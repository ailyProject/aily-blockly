import { Component, ElementRef, OnDestroy, OnInit, signal, viewChild } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { AppShellComponent } from '@/layout/app-shell.component'
import { getCore } from '@/utils/core'
import { getDesktop, loadDesktopHostRuntimeInfo } from '@/utils/desktop'

import {
	createSerialMonitorLoadActions,
	createSerialMonitorSessionActions,
	createSerialMonitorUploadActions
} from './actions'
import {
	SerialMonitorConnectionCardComponent,
	SerialMonitorQuickSendCardComponent,
	SerialMonitorStreamCardComponent,
	SerialMonitorUploadCardComponent
} from './components'
import { createSerialMonitorSignals } from './utils/signals'
import { createSerialMonitorViewActions } from './utils/view'

import type { SerialSessionMessage } from '@core'
import type { SerialMonitorPageState, SerialMonitorSignals, SerialMonitorUploadResultView } from './types'

@Component({
	selector: 'serial-monitor-page',
	imports: [
		AppShellComponent,
		FormsModule,
		HlmBadgeImports,
		HlmButtonImports,
		HlmCardImports,
		SerialMonitorConnectionCardComponent,
		SerialMonitorQuickSendCardComponent,
		SerialMonitorStreamCardComponent,
		SerialMonitorUploadCardComponent
	],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SerialMonitorPageComponent implements OnInit, OnDestroy {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly logBox = viewChild<ElementRef<HTMLDivElement>>('logBox')

	protected readonly state = signal<SerialMonitorPageState | null>(null)
	protected readonly messages = signal<Array<SerialSessionMessage>>([])
	protected readonly inputValue = signal('')
	protected readonly runtimeInfo = signal<Awaited<ReturnType<typeof loadDesktopHostRuntimeInfo>> | null>(null)
	protected readonly uploadResult = signal<SerialMonitorUploadResultView | null>(null)
	protected readonly loading = signal(true)
	protected readonly busy = signal(false)
	protected readonly error = signal<string | null>(null)
	private readonly signals: SerialMonitorSignals = createSerialMonitorSignals({
		state: this.state,
		messages: this.messages,
		inputValue: this.inputValue,
		runtimeInfo: this.runtimeInfo,
		uploadResult: this.uploadResult,
		loading: this.loading,
		busy: this.busy,
		error: this.error
	})
	private readonly viewActions = createSerialMonitorViewActions({
		state: this.state,
		inputValue: this.inputValue,
		getLogBox: () => this.logBox()?.nativeElement,
		pullMessages: port => this.sessionActions.pullMessages(port),
		patchInputMode: patch => this.sessionActions.patchInputMode(patch),
		patchViewMode: patch => this.sessionActions.patchViewMode(patch)
	})
	private readonly sessionActions = createSerialMonitorSessionActions({
		core: this.core,
		signals: this.signals,
		startPolling: port => this.viewActions.startPolling(port),
		stopPolling: () => this.viewActions.stopPolling(),
		scrollToBottom: () => this.viewActions.scrollToBottom()
	})
	private readonly loadActions = createSerialMonitorLoadActions({
		core: this.core,
		desktop: this.desktop,
		signals: this.signals,
		loadDesktopHostRuntimeInfo,
		startPolling: port => this.viewActions.startPolling(port),
		stopPolling: () => this.viewActions.stopPolling(),
		pullMessages: port => this.sessionActions.pullMessages(port)
	})
	private readonly uploadActions = createSerialMonitorUploadActions({
		core: this.core,
		signals: this.signals
	})

	async ngOnInit() {
		await this.loadActions.loadRuntimeInfo()
		await this.loadActions.refresh()
	}

	async ngOnDestroy() {
		this.viewActions.dispose()
		await this.sessionActions.disconnectCurrent()
	}

	protected readonly refresh = this.loadActions.refresh
	protected readonly toggleConnection = this.sessionActions.toggleConnection
	protected readonly choosePort = this.sessionActions.choosePort
	protected readonly chooseBaudRate = this.sessionActions.chooseBaudRate
	protected readonly clearMessages = this.sessionActions.clearMessages
	protected readonly send = this.sessionActions.send
	protected readonly sendQuick = this.sessionActions.sendQuick
	protected readonly onInputKeydown = this.sessionActions.onInputKeydown
	protected readonly runUpload = this.uploadActions.runUpload
	protected readonly reconnect = this.sessionActions.reconnect
	protected readonly toggleHexView = () => this.viewActions.toggleHexView()
	protected readonly toggleTimestamp = () => this.viewActions.toggleTimestamp()
	protected readonly toggleAutoScroll = () => this.viewActions.toggleAutoScroll()
	protected readonly toggleHexInput = () => this.viewActions.toggleHexInput()
	protected readonly toggleSendByEnter = () => this.viewActions.toggleSendByEnter()
	protected readonly toggleEndR = () => this.viewActions.toggleEndR()
	protected readonly toggleEndN = () => this.viewActions.toggleEndN()
}
