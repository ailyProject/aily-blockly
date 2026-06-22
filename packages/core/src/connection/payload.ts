import type { ConnectionComponentConfig, ConnectionGraphData, ConnectionGraphPayload } from './types'

/**
 * 构建连线图 iframe 载荷。
 * @param data - 连线图数据
 * @param componentConfigs - 组件配置映射
 * @param theme - 页面主题
 */
export const buildConnectionGraphPayload = (
	data: ConnectionGraphData,
	componentConfigs: Record<string, ConnectionComponentConfig>,
	theme: 'light' | 'dark' = 'dark'
): ConnectionGraphPayload => ({
	componentConfigs,
	components: data.components,
	connections: data.connections,
	theme
})
