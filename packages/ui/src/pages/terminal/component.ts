import '@xterm/xterm/css/xterm.css'

import { Component, ElementRef, OnDestroy, OnInit, signal, viewChild } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { AppShellComponent } from '@/layout/app-shell.component'
import { getCore } from '@/utils/core'
import { getDesktop, hasBleChooserBridge, loadDesktopHostRuntimeInfo, selectDesktopDirectory } from '@/utils/desktop'

import { createTerminalBuildActions, createTerminalOutputActions, createTerminalSessionActions } from './actions'
import { startTerminalBleDiscovery } from './utils/ble'
import { setupTerminalPageEffects } from './utils/effects'
import { chooseTerminalBleDevice, copyTerminalOutput, pasteTerminalClipboard } from './utils/interactions'
import { createTerminalPageState } from './utils/state'
import { mountTerminalXterm, unmountTerminalXterm } from './utils/xterm'

import type { Unsubscribable } from '@trpc/server/observable'
import type { TerminalXtermRuntime } from './runtime/xterm'

@Component({
	selector: 'terminal-page',
	imports: [AppShellComponent, HlmBadgeImports, HlmButtonImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class TerminalPageComponent implements OnInit, OnDestroy {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly terminalHost = viewChild<ElementRef<HTMLElement>>('terminalHost')
	private subscription: Unsubscribable | null = null
	private bleSubscription: Unsubscribable | null = null
	private readonly state = createTerminalPageState()
	private xtermRuntime: TerminalXtermRuntime | null = null
	private renderedChunkCount = 0
	private renderedSessionId = ''
	private readonly terminalReady = signal(0)

	protected readonly session = this.state.session
	protected readonly viewport = this.state.viewport
	protected readonly runtimeInfo = this.state.runtimeInfo
	protected readonly uploadTargets = this.state.uploadTargets
	protected readonly selectedUploadTargetId = this.state.selectedUploadTargetId
	protected readonly lastUploadSummary = this.state.lastUploadSummary
	protected readonly lines = this.state.lines
	protected readonly lineCount = this.state.lineCount
	protected readonly actionBusy = this.state.actionBusy
	protected readonly actionKind = this.state.actionKind
	protected readonly loading = this.state.loading
	protected readonly error = this.state.error
	protected readonly bleBridgeAvailable = this.state.bleBridgeAvailable
	protected readonly selectedUploadTarget = this.state.selectedUploadTarget
	protected readonly selectedUploadTargetLabel = this.state.selectedUploadTargetLabel
	private readonly signals = this.state.signals
	private readonly outputActions = createTerminalOutputActions(this.signals)
	private readonly sessionActions = createTerminalSessionActions({
		core: this.core,
		desktop: this.desktop,
		signals: this.signals,
		selectDesktopDirectory,
		loadDesktopHostRuntimeInfo,
		appendOutput: this.outputActions.appendOutput.bind(this.outputActions),
		getSubscription: () => this.subscription,
		setSubscription: subscription => {
			this.subscription = subscription
		}
	})
	private readonly buildActions = createTerminalBuildActions({
		core: this.core,
		desktop: this.desktop,
		signals: this.signals,
		appendOutput: this.outputActions.appendOutput.bind(this.outputActions),
		appendBuildLogs: this.outputActions.appendBuildLogs.bind(this.outputActions),
		appendUploadProgress: this.outputActions.appendUploadProgress.bind(this.outputActions),
		appendUploadSummary: this.outputActions.appendUploadSummary.bind(this.outputActions)
	})

	constructor() {
		setupTerminalPageEffects({
			desktop: this.desktop,
			terminalHost: this.terminalHost,
			terminalReady: this.terminalReady,
			getSessionId: () => this.session()?.id || '',
			getLines: () => this.lines(),
			getRuntime: () => this.xtermRuntime,
			getRenderedSessionId: () => this.renderedSessionId,
			getRenderedChunkCount: () => this.renderedChunkCount,
			setRenderedState: state => {
				this.renderedSessionId = state.renderedSessionId
				this.renderedChunkCount = state.renderedChunkCount
			},
			initializeTerminal: host => {
				this.initializeTerminal(host)
			},
			disposeTerminal: () => {
				this.disposeTerminal()
			},
			syncViewport: async (host, viewport) => {
				await this.sessionActions.syncViewport(host, viewport)
			}
		})
	}

	async ngOnInit() {
		this.bleBridgeAvailable.set(hasBleChooserBridge(this.desktop))
		await this.sessionActions.initialize()
		if (this.bleBridgeAvailable()) {
			this.bleSubscription = startTerminalBleDiscovery({
				desktop: this.desktop,
				uploadTargets: this.uploadTargets,
				selectedUploadTargetId: this.selectedUploadTargetId,
				chooseUploadTarget: this.sessionActions.chooseUploadTarget,
				onError: error => {
					this.error.set(error instanceof Error ? error.message : String(error))
				}
			})
		}
	}

	async ngOnDestroy() {
		this.bleSubscription?.unsubscribe()
		this.disposeTerminal()
		await this.sessionActions.destroy()
	}

	protected async interrupt() {
		if (await this.buildActions.interruptRunningAction()) return
		await this.sessionActions.interrupt()
	}

	protected readonly runPwd = this.sessionActions.runPwd
	protected readonly chooseWorkingDirectory = this.sessionActions.chooseWorkingDirectory
	protected readonly clear = this.sessionActions.clear
	protected readonly chooseUploadTarget = this.sessionActions.chooseUploadTarget
	protected readonly runCurrentBuild = this.buildActions.runCurrentBuild
	protected readonly runCurrentUpload = this.buildActions.runCurrentUpload
	protected readonly retryCurrentUpload = () => this.buildActions.runCurrentUpload()
	protected readonly copyOutput = () => copyTerminalOutput({ runtime: this.xtermRuntime, lines: this.lines() })
	protected readonly pasteClipboard = () =>
		pasteTerminalClipboard({
			desktop: this.desktop,
			getSessionId: () => this.session()?.id || '',
			runtime: this.xtermRuntime,
			onError: error => {
				this.error.set(error instanceof Error ? error.message : String(error))
			}
		})
	protected readonly selectBleDevice = () =>
		chooseTerminalBleDevice({
			desktop: this.desktop,
			uploadTargets: this.uploadTargets,
			selectedUploadTargetId: this.selectedUploadTargetId,
			chooseUploadTarget: this.sessionActions.chooseUploadTarget,
			onError: error => {
				this.error.set(error instanceof Error ? error.message : String(error))
			}
		})

	private initializeTerminal(host: HTMLElement) {
		this.xtermRuntime = mountTerminalXterm({
			host,
			desktop: this.desktop,
			getSessionId: () => this.session()?.id || '',
			onError: error => {
				this.error.set(error instanceof Error ? error.message : String(error))
			}
		})
		this.renderedChunkCount = 0
		this.renderedSessionId = ''
		this.terminalReady.update(value => value + 1)
	}

	private disposeTerminal() {
		unmountTerminalXterm(this.xtermRuntime)
		this.xtermRuntime = null
		this.renderedChunkCount = 0
		this.renderedSessionId = ''
		this.terminalReady.update(value => value + 1)
	}
}
