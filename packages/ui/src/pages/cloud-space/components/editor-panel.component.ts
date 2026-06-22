import { Component, input, output } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import type { CloudProjectSummary } from 'shared'

/**
 * Cloud Space 项目元数据编辑面板。
 */
@Component({
	selector: 'cloud-space-editor-panel',
	imports: [FormsModule, HlmBadgeImports, HlmButtonImports, HlmCardImports, HlmInputImports],
	templateUrl: './editor-panel.component.html',
	styleUrl: './editor-panel.component.css'
})
export class CloudSpaceEditorPanelComponent {
	/** 当前正在编辑的项目。 */
	readonly project = input.required<CloudProjectSummary>()
	/** 当前昵称草稿。 */
	readonly nickname = input('')
	/** 当前描述草稿。 */
	readonly description = input('')
	/** 当前文档链接草稿。 */
	readonly docUrl = input('')
	/** 当前标签草稿。 */
	readonly tags = input('')
	/** 当前封面预览。 */
	readonly imagePreviewUrl = input<string | null>(null)
	/** 当前是否已标记保存时清空封面。 */
	readonly removeCover = input(false)
	/** 当前是否正在保存。 */
	readonly saveBusy = input(false)
	/** 当前是否正在处理图片。 */
	readonly imageBusy = input(false)
	/** 当前错误提示。 */
	readonly errorMessage = input<string | null>(null)
	/** 请求关闭编辑器。 */
	readonly cancel = output<void>()
	/** 提交新的昵称。 */
	readonly nicknameChange = output<string>()
	/** 提交新的描述。 */
	readonly descriptionChange = output<string>()
	/** 提交新的文档链接。 */
	readonly docUrlChange = output<string>()
	/** 提交新的标签串。 */
	readonly tagsChange = output<string>()
	/** 请求选择封面图。 */
	readonly imageSelect = output<Event>()
	/** 请求清空封面图。 */
	readonly imageClear = output<void>()
	/** 请求保存元数据。 */
	readonly save = output<void>()

	/**
	 * 转发昵称输入。
	 * @param event - 输入事件
	 */
	protected updateNickname(event: Event) {
		this.nicknameChange.emit((event.target as HTMLInputElement).value)
	}

	/**
	 * 转发描述输入。
	 * @param event - 输入事件
	 */
	protected updateDescription(event: Event) {
		this.descriptionChange.emit((event.target as HTMLTextAreaElement).value)
	}

	/**
	 * 转发文档链接输入。
	 * @param event - 输入事件
	 */
	protected updateDocUrl(event: Event) {
		this.docUrlChange.emit((event.target as HTMLInputElement).value)
	}

	/**
	 * 转发标签输入。
	 * @param event - 输入事件
	 */
	protected updateTags(event: Event) {
		this.tagsChange.emit((event.target as HTMLInputElement).value)
	}

	/**
	 * 转发图片选择事件。
	 * @param event - 输入事件
	 */
	protected selectImage(event: Event) {
		this.imageSelect.emit(event)
	}
}
