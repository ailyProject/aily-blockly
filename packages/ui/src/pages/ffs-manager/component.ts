import { Component, OnInit, signal, viewChild } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'

import { getCore } from '@/utils/core'

import { createFfsPreviewDirectory, renameFfsPreviewEntry } from './component.edit.actions'
import { createFfsManagerHandlers } from './component.handlers'
import { createFfsManagerViewModel } from './component.viewmodel'
import { FfsManagerPreviewPanelComponent, FfsManagerSummaryPanelsComponent } from './components'
import { loadFfsManagerState } from './runtime'

import type { FfsManagerState } from './types'

@Component({
	selector: 'ffs-manager-page',
	imports: [
		FfsManagerPreviewPanelComponent,
		FfsManagerSummaryPanelsComponent,
		HlmBadgeImports,
		HlmButtonImports,
		HlmCardImports
	],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class FfsManagerPageComponent implements OnInit {
	private readonly core = getCore()

	protected readonly imageInput = viewChild.required<HTMLInputElement>('imageInput')
	protected readonly fileInput = viewChild.required<HTMLInputElement>('fileInput')
	protected readonly state = signal<FfsManagerState | null>(null)
	private readonly viewModel = createFfsManagerViewModel(this.state)
	protected readonly imageBytes = this.viewModel.imageBytes
	protected readonly imageName = this.viewModel.imageName
	protected readonly previewText = this.viewModel.previewText
	protected readonly previewFilePath = this.viewModel.previewFilePath
	protected readonly actionMessage = this.viewModel.actionMessage
	protected readonly previewBusy = this.viewModel.previewBusy
	protected readonly currentPath = this.viewModel.currentPath
	protected readonly breadcrumbs = this.viewModel.breadcrumbs
	protected readonly explorerEntries = this.viewModel.explorerEntries
	private readonly handlers = createFfsManagerHandlers({
		core: this.core,
		state: this.state,
		imageBytes: this.imageBytes,
		imageName: this.imageName,
		previewText: this.previewText,
		previewFilePath: this.previewFilePath,
		actionMessage: this.actionMessage,
		previewBusy: this.previewBusy,
		currentPath: this.currentPath
	})

	async ngOnInit() {
		this.state.set(await loadFfsManagerState(this.core))
	}
	protected readonly handleImageFileChange = this.handlers.handleImageFileChange
	protected readonly handleFileUploadChange = this.handlers.handleFileUploadChange
	protected readonly formatCurrentImage = this.handlers.formatCurrentImage
	protected readonly previewEntry = this.handlers.previewEntry
	protected readonly deleteEntry = this.handlers.deleteEntry
	protected readonly downloadImage = this.handlers.downloadImage

	protected async renameEntry(entry: {
		fullPath: string
		name: string
		type: 'file' | 'dir'
		size: number
		sizeText: string
	}) {
		const bytes = this.imageBytes()
		const current = this.state()
		if (!bytes || !current) return

		const nextPath = window.prompt('Rename path', entry.fullPath)
		if (!nextPath || nextPath.trim() === entry.fullPath) return

		this.previewBusy.set(true)
		try {
			const result = await renameFfsPreviewEntry({
				core: this.core,
				currentState: current,
				imageBytes: bytes,
				entry,
				nextPath: nextPath.trim()
			})
			this.imageBytes.set(result.imageBytes)
			this.actionMessage.set(result.actionMessage)
			this.state.update(state => (state ? { ...state, preview: result.preview } : state))
		} finally {
			this.previewBusy.set(false)
		}
	}

	protected async createDirectory() {
		const bytes = this.imageBytes()
		const current = this.state()
		if (!bytes || !current) return

		const defaultPath = this.currentPath() === '/' ? '/new-folder' : `${this.currentPath()}/new-folder`
		const path = window.prompt('Directory path', defaultPath)
		if (!path || !path.trim()) return

		this.previewBusy.set(true)
		try {
			const result = await createFfsPreviewDirectory({
				core: this.core,
				currentState: current,
				imageBytes: bytes,
				path: path.trim()
			})
			this.imageBytes.set(result.imageBytes)
			this.actionMessage.set(result.actionMessage)
			this.state.update(state => (state ? { ...state, preview: result.preview } : state))
		} finally {
			this.previewBusy.set(false)
		}
	}
}
