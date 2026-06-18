import type { AilyCoreServiceAddress, AilyCoreServiceHealth, AilyCoreServiceStartOptions } from 'shared'
import type { router } from './index'

/**
 * Core 服务 tRPC 上下文
 */
export interface AilyCoreServiceContext {
	/** 本次请求生成的唯一 ID */
	requestId: string
	/** 服务进程启动时间戳 */
	startedAt: number
}

/**
 * 创建 Core 路由时使用的运行时元数据
 */
export interface CreateAilyCoreRouterOptions {
	/** 服务版本号 */
	version: string
	/** 服务启动时间戳 */
	startedAt: number
	/** 当前监听地址 */
	address: AilyCoreServiceAddress
	/** 当前启动链路传输方式 */
	transport: AilyCoreServiceStartOptions['transport']
}

/**
 * 创建 Core 服务实例时的选项
 */
export interface CreateAilyCoreServerOptions extends AilyCoreServiceStartOptions {
	/** 服务版本号 */
	version?: string
}

/**
 * Core 服务运行句柄
 */
export interface AilyCoreServiceHandle {
	/** 对外暴露的地址信息 */
	address: AilyCoreServiceAddress
	/** 启动服务并开始监听 */
	start(): Promise<AilyCoreServiceAddress>
	/** 停止当前服务实例 */
	stop(): Promise<void>
	/** 获取当前健康状态快照 */
	getHealthSnapshot(): AilyCoreServiceHealth
}

/**
 * Core 根 tRPC 路由类型
 */
export type Router = ReturnType<typeof router>
