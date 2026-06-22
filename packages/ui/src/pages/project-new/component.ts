import { Component, computed, inject, OnInit } from '@angular/core'
import { Router } from '@angular/router'
import { HlmCardImports } from 'spartan/card'

import { getCore } from '@/utils/core'
import { getDesktop, loadDesktopHostRuntimeInfo, selectDesktopDirectory } from '@/utils/desktop'

import { createProjectNewFormActions, createProjectNewProjectActions } from './actions'
import {
	ProjectNewBoardPanelComponent,
	ProjectNewRecentPanelComponent,
	ProjectNewSetupPanelComponent,
	ProjectNewTemplatePanelComponent
} from './components'
import { projectNewConfig, projectNewSeparator, projectNewUserDocuments } from './data'
import { loadProjectNewDefaults } from './runtime'
import { createProjectNewPageState } from './utils/state'

@Component({
	selector: 'project-new-page',
	imports: [
		HlmCardImports,
		ProjectNewBoardPanelComponent,
		ProjectNewRecentPanelComponent,
		ProjectNewSetupPanelComponent,
		ProjectNewTemplatePanelComponent
	],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ProjectNewPageComponent implements OnInit {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly router = inject(Router)
	private readonly state = createProjectNewPageState()
	protected readonly loading = this.state.loading
	protected readonly error = this.state.error
	protected readonly authToken = this.state.authToken
	protected readonly projectName = this.state.projectName
	protected readonly selectedBoardName = this.state.selectedBoardName
	protected readonly rootPath = this.state.rootPath
	protected readonly resolvedProjectPath = this.state.resolvedProjectPath
	protected readonly recentProjects = this.state.recentProjects
	protected readonly templates = this.state.templates
	protected readonly hasExamples = this.state.hasExamples
	protected readonly selectedTemplateId = this.state.selectedTemplateId
	protected readonly pathConflict = this.state.pathConflict
	protected readonly nameValidationMessage = this.state.nameValidationMessage
	protected readonly importBusy = this.state.importBusy
	protected readonly importMessage = this.state.importMessage
	protected readonly templateSourceMode = this.state.templateSourceMode
	protected readonly runtimeInfo = this.state.runtimeInfo
	protected readonly boardOptions = this.state.boardOptions
	protected readonly selectedTemplate = this.state.selectedTemplate
	private readonly signals = this.state.signals
	private readonly formActions = createProjectNewFormActions({
		core: this.core,
		desktop: this.desktop,
		signals: this.signals,
		boardOptions: this.boardOptions,
		projectNewSeparator,
		loadDesktopHostRuntimeInfo,
		selectDesktopDirectory
	})
	private readonly projectActions = createProjectNewProjectActions({
		core: this.core,
		router: this.router,
		signals: this.signals,
		boardOptions: this.boardOptions,
		selectedTemplate: () => this.selectedTemplate()
	})

	async ngOnInit() {
		await this.formActions.loadRuntimeInfo()
		await this.refresh()
	}

	protected async refresh() {
		this.loading.set(true)
		this.error.set(null)

		try {
			const defaults = await loadProjectNewDefaults(this.core, {
				userDocuments: this.runtimeInfo()?.documentsPath || projectNewUserDocuments,
				separator: this.runtimeInfo()?.pathSeparator || projectNewSeparator,
				config: projectNewConfig,
				runtimeInfo: this.runtimeInfo()
			})
			this.rootPath.set(defaults.rootPath)
			this.recentProjects.set(defaults.recentProjects)
			await this.formActions.preview()
			await this.formActions.refreshTemplates()
		} catch (error) {
			this.error.set((error as Error).message)
		} finally {
			this.loading.set(false)
		}
	}

	protected readonly updateProjectName = this.formActions.updateProjectName
	protected readonly updateAuthToken = this.formActions.updateAuthToken
	protected readonly updateProjectNameValue = this.formActions.updateProjectNameValue
	protected readonly updateAuthTokenValue = this.formActions.updateAuthTokenValue
	protected readonly selectTemplateSourceMode = this.formActions.selectTemplateSourceMode
	protected readonly chooseBoard = this.formActions.chooseBoard
	protected readonly chooseRootPath = this.formActions.chooseRootPath
	protected readonly useRecentProject = this.formActions.useRecentProject
	protected readonly chooseTemplate = this.formActions.chooseTemplate
	protected readonly suggestAvailableName = this.formActions.suggestAvailableName
	protected readonly createBlankProject = this.projectActions.createBlankProject
	protected readonly importSelectedTemplate = this.projectActions.importSelectedTemplate
	protected readonly canCreateBlankProject = computed(
		() =>
			!this.importBusy() &&
			this.pathConflict() !== true &&
			!this.nameValidationMessage() &&
			!!this.runtimeInfo()?.appDataPath
	)
}
