import type { AilyCoreServiceHealth } from 'shared'

/**
 * 模型部署页展示状态
 */
export interface ModelDeployState {
	/** 当前 core 服务健康状态 */
	health: AilyCoreServiceHealth
	/** 当前可用部署目标数量 */
	deployTargetCount: number
	/** desktop 串口数量 */
	serialPortCount: number
	/** desktop 宿主平台 */
	platform: string
	/** probe 设备数量 */
	probeCount: number
	/** esptool 是否可用 */
	esptoolAvailable: boolean
	/** 固件版本 */
	firmwareVersion: string | null
}
