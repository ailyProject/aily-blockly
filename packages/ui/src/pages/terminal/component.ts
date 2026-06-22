import '@xterm/xterm/css/xterm.css'

import { Component, effect, ElementRef, OnDestroy, OnInit, signal, viewChild } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { AppShellComponent } from '@/layout/app-shell.component'
import { getCore } from '@/utils/core'
import { getDesktop, hasBleChooserBridge, loadDesktopHostRuntimeInfo, selectDesktopDirectory } from '@/utils/desktop'

import { createTerminalBuildActions, createTerminalOutputActions, createTerminalSessionActions } from './actions'
import { selectTerminalBleDevice, startTerminalBleDiscovery } from './component.ble'
import { createTerminalPageState } from './component.state'
import { writeTerminalInput } from './runtime'
import {
	createTerminalXtermRuntime,
	disposeTerminalXtermRuntime,
	resolveTerminalXtermViewport,
	syncTerminalXtermOutput
} from './runtime/xterm'

import type { Unsubscribable } from '@trpc/server/observable'

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
	private xtermRuntime: ReturnType<typeof createTerminalXtermRuntime> | null = null
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
		effect(onCleanup => {
			const host = this.terminalHost()?.nativeElement
			if (!host || this.xtermRuntime) return

			this.initializeTerminal(host)
			onCleanup(() => {
				this.disposeTerminal()
			})
		})

		effect(onCleanup => {
			const terminalHost = this.terminalHost()?.nativeElement
			this.terminalReady()
			if (!this.desktop || !this.session() || !terminalHost || !this.xtermRuntime) return

			const syncViewport = async () => {
				const nextViewport = resolveTerminalXtermViewport(this.xtermRuntime, terminalHost)
				await this.sessionActions.syncViewport(this.terminalHost()!, nextViewport)
			}

			const observer = new ResizeObserver(() => {
				void syncViewport().catch(() => null)
			})
			observer.observe(terminalHost)
			void syncViewport().catch(() => null)

			onCleanup(() => {
				observer.disconnect()
			})
		})

		effect(() => {
			this.terminalReady()
			if (!this.xtermRuntime) return

			const nextState = syncTerminalXtermOutput({
				runtime: this.xtermRuntime,
				sessionId: this.session()?.id || '',
				renderedSessionId: this.renderedSessionId,
				renderedChunkCount: this.renderedChunkCount,
				chunks: this.lines()
			})
			this.renderedSessionId = nextState.renderedSessionId
			this.renderedChunkCount = nextState.renderedChunkCount
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
	protected readonly copyOutput = async () => {
		const selectedText = this.xtermRuntime?.terminal.getSelection() || ''
		const text = selectedText.trim() ? selectedText : this.lines().join('')
		if (!text.trim()) return

		try {
			if (navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text)
				return
			}
		} catch {
			// fall through to legacy copy path
		}

		const textarea = document.createElement('textarea')
		textarea.value = text
		textarea.setAttribute('readonly', 'true')
		textarea.style.position = 'fixed'
		textarea.style.opacity = '0'
		document.body.appendChild(textarea)
		textarea.select()
		document.execCommand('copy')
		document.body.removeChild(textarea)
	}
	protected readonly pasteClipboard = async () => {
		try {
			const text = await navigator.clipboard?.readText()
			const sessionId = this.session()?.id
			if (!text || !this.desktop || !sessionId) return
			await writeTerminalInput(this.desktop, sessionId, text)
			this.xtermRuntime?.terminal.focus()
		} catch (error) {
			this.error.set(error instanceof Error ? error.message : String(error))
		}
	}
	protected readonly selectBleDevice = () =>
		selectTerminalBleDevice({
			desktop: this.desktop,
			uploadTargets: this.uploadTargets,
			selectedUploadTargetId: this.selectedUploadTargetId,
			chooseUploadTarget: this.sessionActions.chooseUploadTarget,
			onError: error => {
				this.error.set(error instanceof Error ? error.message : String(error))
			}
		})

	private initializeTerminal(host: HTMLElement) {
		this.xtermRuntime = createTerminalXtermRuntime(host, data => {
			const sessionId = this.session()?.id
			if (!this.desktop || !sessionId) return
			void writeTerminalInput(this.desktop, sessionId, data).catch(error => {
				this.error.set(error instanceof Error ? error.message : String(error))
			})
		})
		this.renderedChunkCount = 0
		this.renderedSessionId = ''
		this.terminalReady.update(value => value + 1)
	}

	private disposeTerminal() {
		disposeTerminalXtermRuntime(this.xtermRuntime)
		this.xtermRuntime = null
		this.renderedChunkCount = 0
		this.renderedSessionId = ''
		this.terminalReady.update(value => value + 1)
	}
}
