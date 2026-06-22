/**
 * 子工具目录条目
 */
export interface ChildToolItem {
	/** 子工具唯一标识 */
	id: string
	/** 子工具显示标题 */
	title: string
	/** 子工具用途摘要 */
	summary: string
	/** 子工具推荐启动路径 */
	launchPath: string
}

/**
 * 子工具宿主信息。
 */
export interface ChildToolHostInfo {
	/** 子工具访问地址。 */
	url: string
	/** 子工具允许的源。 */
	origin?: string
	/** 子工具 websocket 地址。 */
	wsUrl?: string
	/** 子工具关闭地址。 */
	shutdownUrl?: string
	/** 子工具监听端口。 */
	port?: number
	/** 子工具进程号。 */
	pid?: number
}
