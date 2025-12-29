/**
 * 子应用配置接口
 * 定义子应用的基本信息和运行参数
 */
export interface SubAppConfig {
  /** 子应用唯一标识 */
  id: string;
  
  /** 子应用显示名称 */
  name: string;
  
  /** 开发模式端口号 */
  devPort: number;
  
  /** 生产模式路径 (相对于主应用) */
  prodPath: string;
  
  /** 工具面板路由路径 (可选) */
  routePath?: string;
  
  /** 连接超时时间 (毫秒, 默认 10000) */
  connectionTimeout?: number;
}

/**
 * 子应用 Bridge 服务接口
 * 所有子应用的 Bridge 服务都需要实现这个接口
 */
export interface SubAppBridge {
  /** 初始化与 iframe 的连接 */
  initConnection(iframeRef: any, config?: SubAppConfig): Promise<void>;
  
  /** 销毁连接 */
  destroy(appId?: string): void;
  
  /** 检查连接是否就绪 */
  isConnectionReady(appId?: string): boolean;
}

/**
 * 预定义的子应用配置
 */
export const SUBAPP_CONFIGS: { [key: string]: SubAppConfig } = {
  'serial-monitor': {
    id: 'serial-monitor',
    name: '串口监视器',
    devPort: 4201,
    prodPath: './serial-monitor-app/index.html',
    routePath: '/serial-monitor',
    connectionTimeout: 10000
  },
  // 可以在这里添加更多子应用配置
  // 'data-chart': {
  //   id: 'data-chart',
  //   name: '数据图表',
  //   devPort: 4202,
  //   prodPath: './data-chart-app/index.html',
  //   routePath: '/data-chart',
  // },
};

/**
 * 获取子应用 URL
 */
export function getSubAppUrl(config: SubAppConfig): string {
  const isDev = window.location.port === '4200';
  return isDev
    ? `http://localhost:${config.devPort}`
    : config.prodPath;
}
