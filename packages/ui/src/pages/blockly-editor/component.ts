import { Component, inject, OnDestroy, OnInit } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { ActivatedRoute, Router } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { subscribeProjectMutationEvent } from '@/runtime/project-events'
import { closeProjectInEditor } from '@/runtime/project-routing'
import { getCurrentProjectPath } from '@/runtime/project-session'
import { getCore } from '@/utils/core'

import { initializeBlocklyEditorPage } from './component.runtime'
import { startBlocklyEditorLifecycleWatch } from './component.runtime/lifecycle-watch'
import { createBlocklyEditorPageState } from './component.state'
import { BlocklyEditorInspectorPanelComponent, BlocklyEditorWorkspaceShellComponent } from './components'
import { blocklyEditorWorkspaceHints } from './data'
import { createBlocklyEditorPageActions } from './page-actions.runtime'

import type { MissingBlocklyLibraryInfo } from 'shared'
import type { BlocklyEditorPageSummary } from './types'

const renderBlocklyLibraryMutationVerb = (action: 'install' | 'remove') =>
	action === 'install' ? 'installed' : 'removed'

@Component({
	selector: 'blockly-editor-page',
	imports: [
		BlocklyEditorInspectorPanelComponent,
		BlocklyEditorWorkspaceShellComponent,
		FormsModule,
		HlmBadgeImports,
		HlmButtonImports,
		HlmCardImports
	],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class BlocklyEditorPageComponent implements OnInit, OnDestroy {
	private readonly core = getCore()
	private readonly route = inject(ActivatedRoute)
	private readonly router = inject(Router)
	private readonly state = createBlocklyEditorPageState()
	private stopLifecycleWatch: (() => void) | null = null
	private stopLibraryMutationWatch: (() => void) | null = null

	protected readonly workspaceHints = blocklyEditorWorkspaceHints
	protected readonly projectPath = this.state.projectPath
	protected readonly categories = this.state.categories
	protected readonly boardValidation = this.state.boardValidation
	protected readonly libraryValidation = this.state.libraryValidation
	protected readonly toolbarCount = this.state.toolbarCount
	protected readonly visibleToolbarCount = this.state.visibleToolbarCount
	protected readonly language = this.state.language
	protected readonly abiExists = this.state.abiExists
	protected readonly abiFilePath = this.state.abiFilePath
	protected readonly abiParseError = this.state.abiParseError
	protected readonly abiSchemaVersion = this.state.abiSchemaVersion
	protected readonly activePageId = this.state.activePageId
	protected readonly activePageTitle = this.state.activePageTitle
	protected readonly activeViewState = this.state.activeViewState
	protected readonly activeViewScaleDraft = this.state.activeViewScaleDraft
	protected readonly activeViewScrollXDraft = this.state.activeViewScrollXDraft
	protected readonly activeViewScrollYDraft = this.state.activeViewScrollYDraft
	protected readonly activeTopLevelBlockCount = this.state.activeTopLevelBlockCount
	protected readonly activeTopLevelBlockTypes = this.state.activeTopLevelBlockTypes
	protected readonly activeWorkspaceJson = this.state.activeWorkspaceJson
	protected readonly activeWorkspaceDirty = this.state.activeWorkspaceDirty
	protected readonly activeWorkspaceParseError = this.state.activeWorkspaceParseError
	protected readonly activeWorkspaceSaveBusy = this.state.activeWorkspaceSaveBusy
	protected readonly activeWorkspaceSaveMessage = this.state.activeWorkspaceSaveMessage
	protected readonly projectReloadBusy = this.state.projectReloadBusy
	protected readonly projectReloadMessage = this.state.projectReloadMessage
	protected readonly missingLibraries = this.state.missingLibraries
	protected readonly missingLibraryActionBusyKey = this.state.missingLibraryActionBusyKey
	protected readonly missingLibraryActionMessage = this.state.missingLibraryActionMessage
	protected readonly hasBlockingMissingLibraries = this.state.hasBlockingMissingLibraries
	protected readonly renamingPageId = this.state.renamingPageId
	protected readonly renamingPageTitle = this.state.renamingPageTitle
	protected readonly openedPageCount = this.state.openedPageCount
	protected readonly pageCount = this.state.pageCount
	protected readonly totalBlockCount = this.state.totalBlockCount
	protected readonly sharedVariableCount = this.state.sharedVariableCount
	protected readonly sharedProcedureCount = this.state.sharedProcedureCount
	protected readonly pages = this.state.pages
	protected readonly searchQuery = this.state.searchQuery
	protected readonly searchResultNames = this.state.searchResultNames
	protected readonly openedPages = this.state.openedPages
	protected readonly closedPages = this.state.closedPages
	protected readonly canSaveActiveWorkspace = this.state.canSaveActiveWorkspace
	protected readonly canSaveActiveViewState = this.state.canSaveActiveViewState

	private readonly signals = this.state.signals
	private readonly pageActions = createBlocklyEditorPageActions({
		core: this.core,
		signals: this.signals
	})

	async ngOnInit() {
		const projectPath = this.route.snapshot.queryParamMap.get('path') || getCurrentProjectPath() || ''
		await initializeBlocklyEditorPage(this.core, projectPath, this.signals)
		this.stopLifecycleWatch = startBlocklyEditorLifecycleWatch({
			core: this.core,
			projectPath,
			signals: this.signals
		})
		this.stopLibraryMutationWatch = subscribeProjectMutationEvent(async detail => {
			if (detail.type === 'session-change') return
			if (detail.projectPath !== this.projectPath().trim()) return

			if (this.activeWorkspaceDirty()) {
				this.projectReloadMessage.set(
					detail.type === 'cloud-sync'
						? 'Project cloud binding changed outside the editor. Save or reset the current workspace, then reload project state.'
						: `Library ${detail.packageName} was ${renderBlocklyLibraryMutationVerb(detail.action!)} outside the editor. Save or reset the current workspace, then reload project state.`
				)
				return
			}

			this.projectReloadBusy.set(true)
			this.projectReloadMessage.set(null)
			try {
				await initializeBlocklyEditorPage(this.core, this.projectPath().trim(), this.signals)
				this.projectReloadMessage.set(
					detail.type === 'cloud-sync'
						? 'Project cloud binding changed. Workspace reloaded.'
						: `Library ${detail.packageName} ${renderBlocklyLibraryMutationVerb(detail.action!)}. Workspace reloaded.`
				)
			} catch (error) {
				this.projectReloadMessage.set(error instanceof Error ? error.message : String(error))
			} finally {
				this.projectReloadBusy.set(false)
			}
		})
	}

	ngOnDestroy() {
		this.stopLifecycleWatch?.()
		this.stopLibraryMutationWatch?.()
	}

	protected readonly createPage = () => this.pageActions.createPage(this.projectPath())
	protected readonly switchPage = (pageId: string) => this.pageActions.switchPage(this.projectPath(), pageId)
	protected readonly togglePageOpen = (pageId: string, opened: boolean) =>
		this.pageActions.togglePageOpen(this.projectPath(), pageId, opened)
	protected readonly beginRenamePage = this.pageActions.beginRenamePage
	protected readonly cancelRenamePage = this.pageActions.cancelRenamePage
	protected readonly updateRenamingPageTitle = this.pageActions.updateRenamingPageTitle
	protected readonly confirmRenamePage = (page: BlocklyEditorPageSummary) =>
		this.pageActions.confirmRenamePage(this.projectPath(), page)
	protected readonly updateSearchQuery = this.pageActions.updateSearchQuery
	protected readonly updateSearchQueryValue = this.pageActions.updateSearchQueryValue
	protected readonly updateActiveWorkspaceJson = this.pageActions.updateActiveWorkspaceJson
	protected readonly updateActiveViewStateDraft = this.pageActions.updateActiveViewStateDraft
	protected readonly saveActiveViewState = () => this.pageActions.saveActiveViewState(this.projectPath())
	protected readonly resetActiveWorkspaceJson = () => this.pageActions.resetActiveWorkspaceJson(this.projectPath())
	protected readonly saveActiveWorkspaceJson = () => this.pageActions.saveActiveWorkspaceJson(this.projectPath())
	protected readonly reloadProjectState = () => this.pageActions.reloadProjectState(this.projectPath())
	protected readonly restoreMissingLibrary = (library: MissingBlocklyLibraryInfo) =>
		this.pageActions.restoreMissingLibrary(this.projectPath(), library)
	protected readonly restoreAllMissingLibraries = () => this.pageActions.restoreAllMissingLibraries(this.projectPath())
	protected readonly leaveProject = () => closeProjectInEditor(this.core, this.router)
}
