/**
 * Desktop Electron 应用启动参数。
 */
export interface DesktopAppLaunchOptions {
	/** 开发态优先加载的前端地址。 */
	devServerUrl?: string
	/** 生产态静态资源入口文件路径。 */
	indexHtmlPath?: string
}
