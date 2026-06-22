import { Component, input, output } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmButtonImports } from 'spartan/button'

import type { CloudProjectMutationAction, CloudProjectSummary } from 'shared'

/**
 * Cloud Space 项目卡片。
 */
@Component({
	selector: 'cloud-space-project-card',
	imports: [HlmBadgeImports, HlmButtonImports],
	templateUrl: './project-card.component.html',
	styleUrl: './project-card.component.css'
})
export class CloudSpaceProjectCardComponent {
	/** 当前渲染的云项目摘要。 */
	readonly item = input.required<CloudProjectSummary>()
	/** 当前卡片是否对应当前本地项目绑定的云项目。 */
	readonly currentProject = input(false)
	/** 当前是否展示 owner 专属动作。 */
	readonly showActions = input(false)
	/** 当前项目是否处于导入中。 */
	readonly importBusy = input(false)
	/** 当前项目的可见性动作是否忙碌。 */
	readonly publishBusy = input(false)
	/** 当前项目的模板动作是否忙碌。 */
	readonly templateBusy = input(false)
	/** 当前项目的删除动作是否忙碌。 */
	readonly deleteBusy = input(false)
	/** 请求编辑当前项目。 */
	readonly editProject = output<string>()
	/** 向父层请求导入当前项目。 */
	readonly importProject = output<string>()
	/** 向父层请求执行 owner 项目动作。 */
	readonly runAction = output<{ projectId: string; action: CloudProjectMutationAction }>()

	/**
	 * 读取当前项目的可见性动作。
	 */
	protected get visibilityAction() {
		return this.item().isPublished ? 'unpublish' : 'publish'
	}

	/**
	 * 读取当前项目的模板动作。
	 */
	protected get templateAction() {
		return this.item().isTemplate ? 'unset-template' : 'set-template'
	}

	/**
	 * 触发导入动作。
	 */
	protected triggerImport() {
		this.importProject.emit(this.item().id)
	}

	/**
	 * 触发编辑动作。
	 */
	protected triggerEdit() {
		this.editProject.emit(this.item().id)
	}

	/**
	 * 触发当前项目的 owner 动作。
	 * @param action - 需要执行的动作
	 */
	protected triggerAction(action: CloudProjectMutationAction) {
		this.runAction.emit({
			projectId: this.item().id,
			action
		})
	}
}
