import type { AilyCoreServiceHealth } from 'shared'

/**
 * 模型部署页展示状态
 */
export interface ModelDeployState {
	/** 当前 core 服务健康状态 */
	health: AilyCoreServiceHealth
	/** 当前可用部署目标数量 */
	deployTargetCount: number
}
