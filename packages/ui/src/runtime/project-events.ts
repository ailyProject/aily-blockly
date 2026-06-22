type ProjectLibraryMutationAction = 'install' | 'remove'
type ProjectMutationEventType = 'library-mutation' | 'cloud-sync' | 'session-change'

/**
 * 项目库依赖变更事件载荷。
 */
export interface ProjectLibraryMutationEventDetail {
	/** 当前本地项目路径。 */
	projectPath: string
	/** 当前库动作类型。 */
	action: ProjectLibraryMutationAction
	/** 目标库包名。 */
	packageName: string
	/** 事件发出时间。 */
	occurredAt: string
}

/**
 * 通用项目变更事件载荷。
 */
export interface ProjectMutationEventDetail {
	/** 当前本地项目路径。 */
	projectPath: string
	/** 当前变更事件类型。 */
	type: ProjectMutationEventType
	/** 事件发出时间。 */
	occurredAt: string
	/** 当前库动作类型。 */
	action?: ProjectLibraryMutationAction
	/** 目标库包名。 */
	packageName?: string
	/** 云同步后的 cloudId。 */
	cloudId?: string
}

const PROJECT_MUTATION_EVENT = 'aily:project-mutation'

const resolveProjectEventTarget = () => {
	if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
		return window
	}

	return null
}

/**
 * 广播通用项目变更事件。
 * @param detail - 事件载荷
 */
export const dispatchProjectMutationEvent = (detail: ProjectMutationEventDetail) => {
	const target = resolveProjectEventTarget()
	if (!target) return

	target.dispatchEvent(new CustomEvent<ProjectMutationEventDetail>(PROJECT_MUTATION_EVENT, { detail }))
}

/**
 * 订阅通用项目变更事件。
 * @param listener - 事件监听函数
 */
export const subscribeProjectMutationEvent = (listener: (detail: ProjectMutationEventDetail) => void) => {
	const target = resolveProjectEventTarget()
	if (!target) return () => undefined

	const handler = (event: Event) => {
		const detail = (event as CustomEvent<ProjectMutationEventDetail>).detail
		if (detail) {
			listener(detail)
		}
	}

	target.addEventListener(PROJECT_MUTATION_EVENT, handler as EventListener)
	return () => {
		target.removeEventListener(PROJECT_MUTATION_EVENT, handler as EventListener)
	}
}

/**
 * 广播当前项目的库依赖变更事件。
 * @param detail - 事件载荷
 */
export const dispatchProjectLibraryMutationEvent = (detail: ProjectLibraryMutationEventDetail) => {
	dispatchProjectMutationEvent({
		projectPath: detail.projectPath,
		type: 'library-mutation',
		action: detail.action,
		packageName: detail.packageName,
		occurredAt: detail.occurredAt
	})
}

/**
 * 订阅当前项目的库依赖变更事件。
 * @param listener - 事件监听函数
 */
export const subscribeProjectLibraryMutationEvent = (listener: (detail: ProjectLibraryMutationEventDetail) => void) => {
	return subscribeProjectMutationEvent(detail => {
		if (detail.type !== 'library-mutation' || !detail.action || !detail.packageName) return
		listener({
			projectPath: detail.projectPath,
			action: detail.action,
			packageName: detail.packageName,
			occurredAt: detail.occurredAt
		})
	})
}
