import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { ActivatedRoute } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { getCore } from '@/utils/core'
import { getDesktop, loadDesktopHostRuntimeInfo } from '@/utils/desktop'

import {
	prepareCodeEditorBleUpload,
	refreshCodeEditorPlan,
	runCodeEditorBleUploadAction,
	runCodeEditorBuildAction,
	runCodeEditorUploadAction,
	selectCodeEditorBleDevice
} from './component.runtime'
import { createCodeEditorSignals } from './component.signals'
import { CodeEditorBuildPanelComponent, CodeEditorProjectPanelComponent } from './components'
import { disposeCodeEditorLifecycle, initializeCodeEditorLifecycle } from './lifecycle.runtime'
import {
	chooseCodeEditorProject,
	reloadCodeEditorProjectState,
	setCodeEditorProjectPath,
	updateCodeEditorSerialPort,
	updateCodeEditorSerialPortValue,
	updateCodeEditorSourceCode
} from './page-actions.runtime'

import type { DesktopHostRuntimeInfo } from '@desktop'
import type { Unsubscribable } from '@trpc/server/observable'
import type {
	CodeEditorBleDeviceListItem,
	CodeEditorBleDeviceView,
	CodeEditorBleUploadPlanView,
	CodeEditorBleUploadProgressView,
	CodeEditorBuildPlanSummary,
	CodeEditorBuildResultView,
	CodeEditorState,
	CodeEditorUploadPlanView,
	CodeEditorUploadResultView
} from './types'

@Component({
	selector: 'code-editor-page',
	imports: [
		CodeEditorBuildPanelComponent,
		CodeEditorProjectPanelComponent,
		FormsModule,
		HlmBadgeImports,
		HlmButtonImports,
		HlmCardImports,
		HlmInputImports
	],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class CodeEditorPageComponent implements OnInit, OnDestroy {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly route = inject(ActivatedRoute)
	private bleSubscription: Unsubscribable | null = null

	protected readonly state = signal<CodeEditorState | null>(null)
	protected readonly runtimeInfo = signal<DesktopHostRuntimeInfo | null>(null)
	protected readonly projectPath = signal('')
	protected readonly sourceCode = signal('')
	protected readonly serialPort = signal('')
	protected readonly buildPlan = signal<CodeEditorBuildPlanSummary | null>(null)
	protected readonly buildResult = signal<CodeEditorBuildResultView | null>(null)
	protected readonly uploadPlan = signal<CodeEditorUploadPlanView | null>(null)
	protected readonly bleUploadPlan = signal<CodeEditorBleUploadPlanView | null>(null)
	protected readonly uploadResult = signal<CodeEditorUploadResultView | null>(null)
	protected readonly bleDevice = signal<CodeEditorBleDeviceView | null>(null)
	protected readonly bleDevices = signal<Array<CodeEditorBleDeviceListItem>>([])
	protected readonly bleUploadProgress = signal<CodeEditorBleUploadProgressView | null>(null)
	protected readonly bleBridgeAvailable = signal(false)
	protected readonly buildError = signal<string | null>(null)
	protected readonly projectReloadMessage = signal<string | null>(null)
	protected readonly projectReloadBusy = signal(false)
	protected readonly buildBusy = signal(false)
	protected readonly uploadBusy = signal(false)

	private readonly signals = createCodeEditorSignals({
		state: this.state,
		runtimeInfo: this.runtimeInfo,
		projectPath: this.projectPath,
		sourceCode: this.sourceCode,
		serialPort: this.serialPort,
		buildPlan: this.buildPlan,
		buildResult: this.buildResult,
		uploadPlan: this.uploadPlan,
		bleUploadPlan: this.bleUploadPlan,
		uploadResult: this.uploadResult,
		bleDevice: this.bleDevice,
		bleDevices: this.bleDevices,
		bleUploadProgress: this.bleUploadProgress,
		bleBridgeAvailable: this.bleBridgeAvailable,
		buildError: this.buildError,
		projectReloadMessage: this.projectReloadMessage,
		projectReloadBusy: this.projectReloadBusy,
		buildBusy: this.buildBusy,
		uploadBusy: this.uploadBusy
	})

	async ngOnInit() {
		this.bleSubscription = await initializeCodeEditorLifecycle({
			core: this.core,
			desktop: this.desktop,
			initialProjectPath: this.route.snapshot.queryParamMap.get('path'),
			loadDesktopHostRuntimeInfo,
			signals: this.signals
		})
	}

	ngOnDestroy() {
		disposeCodeEditorLifecycle(this.bleSubscription)
	}

	protected readonly pageActions = {
		updateProjectPathValue: (projectPath: string) => setCodeEditorProjectPath(this.core, this.signals, projectPath),
		updateSourceCode: (value: string) => updateCodeEditorSourceCode(this.signals, value),
		updateSerialPortValue: (serialPort: string) => updateCodeEditorSerialPortValue(this.core, this.signals, serialPort),
		chooseProject: (projectPath: string) => chooseCodeEditorProject(this.core, this.signals, projectPath),
		reloadProjectState: () => reloadCodeEditorProjectState(this.core, this.signals),
		refreshPlan: () =>
			refreshCodeEditorPlan({
				core: this.core,
				signals: this.signals
			}),
		runBuild: () => runCodeEditorBuildAction({ core: this.core, signals: this.signals }),
		runUpload: () => runCodeEditorUploadAction({ core: this.core, signals: this.signals }),
		selectBleDevice: () => selectCodeEditorBleDevice({ desktop: this.desktop, signals: this.signals }),
		reconnectBleDevice: () => selectCodeEditorBleDevice({ desktop: this.desktop, signals: this.signals }),
		prepareBleUpload: () => prepareCodeEditorBleUpload({ core: this.core, signals: this.signals }),
		runBleUpload: () => runCodeEditorBleUploadAction({ signals: this.signals }),
		selectVisibleBleDevice: (device: CodeEditorBleDeviceListItem) => this.bleDevice.set(device)
	}
}
