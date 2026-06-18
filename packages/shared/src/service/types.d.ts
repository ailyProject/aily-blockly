/**
 * Core 服务启动传输方式
 */
export type AilyCoreServiceTransport =
	/** 直接通过 localhost HTTP 暴露服务 */
	| 'http'
	/** 由桌面壳通过 utility process 托管 */
	| 'utility-process'
/**
 * Core 服务地址信息
 */
export interface AilyCoreServiceAddress {
	/** 监听主机地址 */
	host: string
	/** 监听端口 */
	port: number
	/** 服务根地址 */
	baseUrl: string
	/** tRPC 路由路径 */
	trpcPath: string
	/** tRPC 完整访问地址 */
	trpcUrl: string
	/** 健康检查路径 */
	healthPath: string
	/** 健康检查完整访问地址 */
	healthUrl: string
}
/**
 * Core 服务健康状态快照
 */
export interface AilyCoreServiceHealth {
	/** 服务名称 */
	name: string
	/** 当前健康状态 */
	status: 'ok'
	/** 当前运行版本 */
	version: string
	/** 当前传输方式 */
	transport: AilyCoreServiceTransport
	/** 服务启动时间 ISO 字符串 */
	startedAt: string
	/** 自启动后的运行时长（毫秒） */
	uptimeMs: number
	/** 当前对外暴露的地址信息 */
	address: AilyCoreServiceAddress
}
/**
 * Core 服务运行时状态快照
 */
export interface AilyCoreServiceRuntimeStatus {
	/** 当前服务是否由 desktop manager 持有子进程句柄 */
	managed: boolean
	/** 当前健康检查是否可达 */
	reachable: boolean
	/** 当前最近一次健康检查结果 */
	health: AilyCoreServiceHealth | null
	/** 当前目标地址信息 */
	address: AilyCoreServiceAddress
}
/**
 * Core 服务启动选项
 */
export interface AilyCoreServiceStartOptions {
	/** 覆盖默认监听主机 */
	host?: string
	/** 覆盖默认监听端口 */
	port?: number
	/** 声明当前启动链路来自哪种宿主 */
	transport?: AilyCoreServiceTransport
}
