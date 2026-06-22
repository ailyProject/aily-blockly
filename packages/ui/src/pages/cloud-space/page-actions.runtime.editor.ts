import { encodeCloudProjectCoverFile, processCloudProjectCoverFile } from './runtime/image'
import { updateCloudSpaceProjectMetadata } from './runtime/mutation'

import type { CloudSpaceActionContext } from './page-actions.types'

/**
 * 创建 Cloud Space 的 metadata editor 动作。
 * @param input - 页面动作依赖
 */
export const createCloudSpaceEditorActions = (input: CloudSpaceActionContext) => ({
	beginEditProject(projectId: string) {
		const state = input.getState()
		const project = state.state()?.items.find(item => item.id === projectId)
		if (!project) return

		state.editorImageFile.set(null)
		state.editorError.set(null)
		state.editorDraft.set({
			projectId: project.id,
			nickname: project.nickname || project.name,
			description: project.description || '',
			docUrl: project.docUrl || '',
			tagsText: project.tags.join(', '),
			imagePreviewUrl: project.imageUrl || null,
			removeCover: false
		})
	},
	cancelEditProject() {
		const state = input.getState()
		state.editorDraft.set(null)
		state.editorImageFile.set(null)
		state.editorImageBusy.set(false)
		state.editorError.set(null)
	},
	updateEditorNickname(value: string) {
		const state = input.getState()
		state.editorDraft.update(draft => (draft ? { ...draft, nickname: value } : draft))
	},
	updateEditorDescription(value: string) {
		const state = input.getState()
		state.editorDraft.update(draft => (draft ? { ...draft, description: value } : draft))
	},
	updateEditorDocUrl(value: string) {
		const state = input.getState()
		state.editorDraft.update(draft => (draft ? { ...draft, docUrl: value } : draft))
	},
	updateEditorTags(value: string) {
		const state = input.getState()
		state.editorDraft.update(draft => (draft ? { ...draft, tagsText: value } : draft))
	},
	async selectEditorImage(event: Event) {
		const state = input.getState()
		const inputElement = event.target as HTMLInputElement
		const file = inputElement.files?.[0]
		if (!file) return

		state.editorImageBusy.set(true)
		state.editorError.set(null)
		try {
			const nextImage = await processCloudProjectCoverFile(file)
			state.editorImageFile.set(nextImage.file)
			state.editorDraft.update(draft =>
				draft ? { ...draft, imagePreviewUrl: nextImage.previewUrl, removeCover: false } : draft
			)
		} catch (error) {
			state.editorError.set(error instanceof Error ? error.message : String(error))
		} finally {
			state.editorImageBusy.set(false)
			inputElement.value = ''
		}
	},
	clearEditorImage() {
		const state = input.getState()
		state.editorImageFile.set(null)
		state.editorDraft.update(draft => (draft ? { ...draft, imagePreviewUrl: null, removeCover: true } : draft))
	},
	async saveEditedProject(cancelEditProject: () => void) {
		const state = input.getState()
		const draft = state.editorDraft()
		const authToken = state.authToken().trim()
		if (!draft) return
		if (!authToken) {
			state.editorError.set('Saving project metadata requires a bearer token.')
			return
		}
		if (!draft.nickname.trim()) {
			state.editorError.set('Project nickname is required.')
			return
		}

		state.editorBusy.set(true)
		state.editorError.set(null)
		try {
			const tags = draft.tagsText
				.split(',')
				.map(tag => tag.trim())
				.filter(Boolean)
			const imageFile = state.editorImageFile()
			const imageBase64 = imageFile ? await encodeCloudProjectCoverFile(imageFile) : undefined
			const result = await updateCloudSpaceProjectMetadata({
				core: input.core,
				projectId: draft.projectId,
				authToken,
				metadata: {
					nickname: draft.nickname.trim(),
					description: draft.description.trim(),
					docUrl: draft.docUrl.trim() || undefined,
					tags
				},
				imageBase64,
				imageName: imageFile?.name,
				removeCover: draft.removeCover
			})
			state.currentProjectBinding.update(current =>
				current?.cloudId === draft.projectId
					? {
							...current,
							nickname: draft.nickname.trim()
						}
					: current
			)
			state.statusMessage.set(result.message)
			cancelEditProject()
			await input.refresh()
		} catch (error) {
			state.editorError.set(error instanceof Error ? error.message : String(error))
		} finally {
			state.editorBusy.set(false)
		}
	}
})
