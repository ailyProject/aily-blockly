import type { AilyCoreServiceAddress, AilyCoreServiceRuntimeStatus, AilyCoreServiceStartOptions } from 'shared'

/**
 * 桌面壳管理 Core 服务时的附加选项
 */
export interface DesktopCoreServiceManagerOptions extends AilyCoreServiceStartOptions {
	/** 启动后轮询健康检查的最大等待时间 */
	startupTimeoutMs?: number
	/** 启动阶段的健康检查轮询间隔 */
	healthcheckIntervalMs?: number
	/** 手动覆盖 standalone 入口路径 */
	entryOverride?: string
}

/**
 * 桌面壳中的 Core 服务管理句柄
 */
export interface DesktopCoreServiceManager {
	/** 目标服务地址信息 */
	address: AilyCoreServiceAddress
	/** 启动 Core utility process 并等待服务可用 */
	start(): Promise<AilyCoreServiceAddress>
	/** 停止当前 Core utility process */
	stop(): Promise<void>
	/** 判断当前是否已经持有子进程句柄 */
	isRunning(): boolean
	/** 读取当前服务运行时状态 */
	getStatus(): Promise<AilyCoreServiceRuntimeStatus>
}
