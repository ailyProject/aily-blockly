import { Component, inject, OnInit, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { DomSanitizer } from '@angular/platform-browser'
import { ActivatedRoute } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'

import { setCurrentProjectPath } from '@/runtime/project-session'
import { getCore } from '@/utils/core'
import { getDesktop, selectDesktopDirectory } from '@/utils/desktop'
import { boardIndex } from '@/workspace'

import { createGraphEditorEditActions, createGraphEditorLoadActions } from './actions'
import { GraphEditorFramePanelComponent, GraphEditorWorkspacePanelComponent } from './components'
import { resolveGraphEditorProjectPath, resolveGraphEditorState } from './runtime'

import type { GraphEditorSignals } from './component.types'

@Component({
	selector: 'graph-editor-page',
	imports: [FormsModule, GraphEditorFramePanelComponent, GraphEditorWorkspacePanelComponent, HlmBadgeImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class GraphEditorPageComponent implements OnInit {
	private readonly core = getCore()
	private readonly route = inject(ActivatedRoute)
	private readonly sanitizer = inject(DomSanitizer)

	protected readonly desktop = getDesktop()
	protected readonly boards = boardIndex
	protected readonly loading = signal(true)
	protected readonly error = signal<string | null>(null)
	protected readonly graphJson = signal('')
	protected readonly graphJsonDirty = signal(false)
	protected readonly graphJsonError = signal<string | null>(null)
	protected readonly awsContent = signal('')
	protected readonly awsDirty = signal(false)
	protected readonly cloudAuthToken = signal('')
	protected readonly pinmapHints = signal<Array<string>>([])
	protected readonly pinmapId = signal('')
	protected readonly pinmapJson = signal('')
	protected readonly pinmapJsonError = signal<string | null>(null)
	protected readonly pinmapSaveBusy = signal(false)
	protected readonly pinmapTemplateProtocol = signal('i2c')
	protected readonly pinmapTemplateJson = signal('')
	protected readonly syncBusy = signal(false)
	protected readonly saveMessage = signal<string | null>(null)
	protected readonly state = signal(
		resolveGraphEditorState(
			this.sanitizer,
			this.route.snapshot.queryParamMap.get('url'),
			resolveGraphEditorProjectPath(this.route.snapshot.queryParamMap.get('path'))
		)
	)
	private readonly signals: GraphEditorSignals = {
		loading: this.loading,
		error: this.error,
		graphJson: this.graphJson,
		graphJsonDirty: this.graphJsonDirty,
		graphJsonError: this.graphJsonError,
		awsContent: this.awsContent,
		awsDirty: this.awsDirty,
		cloudAuthToken: this.cloudAuthToken,
		pinmapHints: this.pinmapHints,
		pinmapId: this.pinmapId,
		pinmapJson: this.pinmapJson,
		pinmapJsonError: this.pinmapJsonError,
		pinmapSaveBusy: this.pinmapSaveBusy,
		pinmapTemplateProtocol: this.pinmapTemplateProtocol,
		pinmapTemplateJson: this.pinmapTemplateJson,
		syncBusy: this.syncBusy,
		saveMessage: this.saveMessage,
		state: this.state
	}
	private readonly loadActions = createGraphEditorLoadActions({
		core: this.core,
		desktop: this.desktop,
		route: this.route,
		sanitizer: this.sanitizer,
		signals: this.signals,
		selectDesktopDirectory,
		setCurrentProjectPath
	})
	private readonly editActions = createGraphEditorEditActions({
		core: this.core,
		signals: this.signals,
		refreshLibraryInfo: () => this.loadActions.refreshLibraryInfo(),
		reload: () => this.loadActions.load()
	})

	async ngOnInit() {
		await this.loadActions.load()
	}

	protected readonly updateGraphJson = this.editActions.updateGraphJson
	protected readonly updateAwsContent = this.editActions.updateAwsContent
	protected readonly updateCloudAuthToken = this.editActions.updateCloudAuthToken
	protected readonly updatePinmapId = this.editActions.updatePinmapId
	protected readonly usePinmapId = this.editActions.usePinmapId
	protected readonly usePinmapVariant = this.editActions.usePinmapVariant
	protected readonly updatePinmapJson = this.editActions.updatePinmapJson
	protected readonly updatePinmapTemplateProtocol = this.editActions.updatePinmapTemplateProtocol
	protected readonly saveGraph = this.editActions.saveGraph
	protected readonly saveAws = this.editActions.saveAws
	protected readonly chooseProjectPath = this.loadActions.chooseProjectPath
	protected readonly savePinmap = this.editActions.savePinmap
	protected readonly syncCloudPinmaps = this.editActions.syncCloudPinmaps
}
