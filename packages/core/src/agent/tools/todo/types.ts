/**
 * Todo 状态
 */
export type TodoStatus =
	/** 尚未开始 */
	| 'not-started'
	/** 进行中 */
	| 'in-progress'
	/** 已完成 */
	| 'completed'

/**
 * Todo 优先级
 */
export type TodoPriority =
	/** 高优先级 */
	| 'high'
	/** 中优先级 */
	| 'medium'
	/** 低优先级 */
	| 'low'

/**
 * Todo 项
 */
export interface TodoItem {
	/** 唯一 ID */
	id: number
	/** 任务内容 */
	content: string
	/** 当前状态 */
	status: TodoStatus
	/** 优先级 */
	priority: TodoPriority
	/** 标签列表 */
	tags: Array<string>
	/** 预估工时 */
	estimatedHours?: number
	/** 创建时间戳 */
	createdAt: number
	/** 更新时间戳 */
	updatedAt: number
}

/**
 * Todo 统计结果
 */
export interface TodoStatistics {
	/** 总任务数 */
	total: number
	/** 按状态统计 */
	byStatus: Record<TodoStatus, number>
	/** 按优先级统计 */
	byPriority: Record<TodoPriority, number>
	/** 预估总工时 */
	estimatedTotalHours: number
}

/**
 * Todo 操作类型
 */
export type TodoOperation =
	/** 全量替换 Todo 列表 */
	| 'update'
	/** 追加 Todo */
	| 'add'
	/** 批量追加 Todo */
	| 'batch_add'
	/** 查询 Todo 列表 */
	| 'list'
	/** 读取 Todo 列表 */
	| 'read'
	/** 切换 Todo 状态 */
	| 'toggle'
	/** 删除 Todo */
	| 'delete'
	/** 清空 Todo */
	| 'clear'
	/** 查询统计 */
	| 'stats'

/**
 * Todo 操作结果
 */
export interface TodoOperationResult {
	/** 是否执行成功 */
	ok: boolean
	/** 结果文本 */
	message: string
	/** 更新后的 Todo 列表 */
	todos?: Array<TodoItem>
	/** 统计结果 */
	statistics?: TodoStatistics
}
