const connectionColorMap: Record<string, string> = {
	power: '#EF4444',
	gnd: '#000000',
	i2c: '#8B5CF6',
	spi: '#EC4899',
	uart: '#F59E0B',
	digital: '#3B82F6',
	analog: '#10B981',
	pwm: '#06B6D4',
	gpio: '#10B981',
	other: '#9CA3AF'
}

/**
 * 获取连线类型对应的颜色。
 * @param type - 连线类型
 */
export const getConnectionColor = (type: string) => connectionColorMap[type] || connectionColorMap['other']
