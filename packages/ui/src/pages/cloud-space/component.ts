import { Component, inject, OnInit } from '@angular/core'
import { Router } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { getCurrentProjectPath } from '@/runtime/project-session'
import { getCore } from '@/utils/core'
import { getDesktop, loadDesktopHostRuntimeInfo, selectDesktopDirectory } from '@/utils/desktop'

import { createCloudSpaceActionState, createEditingCloudSpaceProject } from './component.helpers'
import { refreshCloudSpacePage, watchCloudSpaceProjectMutations } from './component.runtime'
import { createCloudSpacePageState } from './component.state'
import {
	CloudSpaceEditorPanelComponent,
	CloudSpaceOverviewPanelComponent,
	CloudSpaceProjectCardComponent
} from './components'
import { createCloudSpacePageActions } from './page-actions.runtime'

import type { CloudProjectMutationAction, CloudProjectScope } from 'shared'

@Component({
	selector: 'cloud-space-page',
	imports: [
		CloudSpaceEditorPanelComponent,
		CloudSpaceOverviewPanelComponent,
		CloudSpaceProjectCardComponent,
		HlmBadgeImports,
		HlmCardImports
	],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class CloudSpacePageComponent implements OnInit {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly router = inject(Router)
	private readonly pageState = createCloudSpacePageState()
	private readonly actionState = createCloudSpaceActionState(this.pageState)
	private stopProjectMutationWatch: (() => void) | null = null

	protected readonly state = this.pageState.state
	protected readonly scope = this.pageState.scope
	protected readonly query = this.pageState.query
	protected readonly board = this.pageState.board
	protected readonly authToken = this.pageState.authToken
	protected readonly page = this.pageState.page
	protected readonly pageSize = this.pageState.pageSize
	protected readonly rootPath = this.pageState.rootPath
	protected readonly pendingTargetPath = this.pageState.pendingTargetPath
	protected readonly targetPathConflict = this.pageState.targetPathConflict
	protected readonly suggestedImportProjectId = this.pageState.suggestedImportProjectId
	protected readonly suggestedImportName = this.pageState.suggestedImportName
	protected readonly importBusyId = this.pageState.importBusyId
	protected readonly actionBusyKey = this.pageState.actionBusyKey
	protected readonly syncBusy = this.pageState.syncBusy
	protected readonly editorDraft = this.pageState.editorDraft
	protected readonly editorBusy = this.pageState.editorBusy
	protected readonly editorImageBusy = this.pageState.editorImageBusy
	protected readonly editorError = this.pageState.editorError
	protected readonly editorImageFile = this.pageState.editorImageFile
	protected readonly syncSummary = this.pageState.syncSummary
	protected readonly syncHistory = this.pageState.syncHistory
	protected readonly currentProjectBinding = this.pageState.currentProjectBinding
	protected readonly statusMessage = this.pageState.statusMessage
	protected readonly runtimeInfo = this.pageState.runtimeInfo
	protected readonly loading = this.pageState.loading
	protected readonly error = this.pageState.error
	protected readonly totalPages = () => {
		const currentState = this.state()
		return currentState ? Math.max(1, Math.ceil(currentState.total / currentState.pageSize)) : 1
	}
	protected readonly editingProject = createEditingCloudSpaceProject(this.pageState, this.editorDraft)
	private readonly pageActions = createCloudSpacePageActions({
		core: this.core,
		desktop: this.desktop,
		router: this.router,
		loadDesktopHostRuntimeInfo,
		selectDesktopDirectory,
		getState: () => this.actionState,
		refresh: () => this.refresh(),
		resetImportSuggestion: () => this.resetImportSuggestion()
	})

	async ngOnInit() {
		await this.pageActions.loadRuntimeInfo()
		await this.refresh()
		this.stopProjectMutationWatch = watchCloudSpaceProjectMutations(this.core, this.pageState)
	}

	ngOnDestroy() {
		this.stopProjectMutationWatch?.()
	}

	protected readonly refresh = () => refreshCloudSpacePage(this.core, this.pageState)
	protected readonly updateQueryValue = (value: string) => {
		this.statusMessage.set(null)
		this.resetImportSuggestion()
		this.page.set(1)
		this.query.set(value)
		void this.refresh()
	}
	protected readonly updateBoardValue = (value: string) => {
		this.statusMessage.set(null)
		this.resetImportSuggestion()
		this.page.set(1)
		this.board.set(value)
		void this.refresh()
	}
	protected readonly updateAuthTokenValue = (value: string) => {
		this.statusMessage.set(null)
		this.authToken.set(value)
	}
	protected readonly selectScope = (scope: CloudProjectScope) => this.pageActions.selectScope(scope)
	protected readonly selectPageSize = (pageSize: number) => this.pageActions.selectPageSize(pageSize)
	protected readonly goToPreviousPage = () => this.pageActions.goToPreviousPage()
	protected readonly goToNextPage = () => this.pageActions.goToNextPage()
	protected readonly chooseRootPath = () => this.pageActions.chooseRootPath()

	protected readonly importProject = (projectId: string, targetName?: string) =>
		this.pageActions.importProject(projectId, targetName)
	protected readonly importProjectWithSuggestedName = () => this.pageActions.importProjectWithSuggestedName()
	protected readonly beginEditProject = (projectId: string) => this.pageActions.beginEditProject(projectId)
	protected readonly cancelEditProject = () => this.pageActions.cancelEditProject()
	protected readonly updateEditorNickname = (value: string) => this.pageActions.updateEditorNickname(value)
	protected readonly updateEditorDescription = (value: string) => this.pageActions.updateEditorDescription(value)
	protected readonly updateEditorDocUrl = (value: string) => this.pageActions.updateEditorDocUrl(value)
	protected readonly updateEditorTags = (value: string) => this.pageActions.updateEditorTags(value)
	protected readonly selectEditorImage = (event: Event) => this.pageActions.selectEditorImage(event)
	protected readonly clearEditorImage = () => this.pageActions.clearEditorImage()
	protected readonly saveEditedProject = () => this.pageActions.saveEditedProject()
	protected readonly runProjectAction = (projectId: string, action: CloudProjectMutationAction) =>
		this.pageActions.runProjectAction(projectId, action)
	protected readonly actionBusy = (projectId: string, action: CloudProjectMutationAction) =>
		this.pageActions.actionBusy(projectId, action)
	protected readonly syncCurrentProject = () => this.pageActions.syncCurrentProject()

	protected hasOpenedProject() {
		return Boolean(getCurrentProjectPath())
	}

	private resetImportSuggestion() {
		this.suggestedImportProjectId.set('')
		this.suggestedImportName.set('')
	}
}
