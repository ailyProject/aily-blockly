import type { ConnectionPinmapConfig } from '../types'

/**
 * 获取 pinmap 配置模板。
 * @param protocol - 协议类型
 */
export const getConnectionPinmapTemplate = (protocol?: string): ConnectionPinmapConfig => {
	const template: ConnectionPinmapConfig = {
		id: 'component_template',
		name: '传感器名称',
		width: 200,
		height: 100,
		images: [{ url: '组件图片的base64编码', x: 0, y: 0, width: 200, height: 100 }],
		pins: [],
		functionTypes: [
			{ value: 'power', label: '电源', color: '#EF4444', textColor: '#FFFFFF' },
			{ value: 'gnd', label: '接地', color: '#000000', textColor: '#FFFFFF' },
			{ value: 'digital', label: '数字', color: '#3B82F6', textColor: '#FFFFFF' },
			{ value: 'analog', label: '模拟', color: '#10B981', textColor: '#FFFFFF' },
			{ value: 'i2c', label: 'I2C', color: '#8B5CF6', textColor: '#FFFFFF' },
			{ value: 'spi', label: 'SPI', color: '#EC4899', textColor: '#FFFFFF' },
			{ value: 'uart', label: 'UART', color: '#F59E0B', textColor: '#FFFFFF' },
			{ value: 'pwm', label: 'PWM', color: '#06B6D4', textColor: '#FFFFFF' }
		]
	}

	const pinTemplates: Record<string, Array<ConnectionPinmapConfig['pins'][number]>> = {
		i2c: [
			{ id: 'pin_1', x: 10, y: 50, layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
			{ id: 'pin_2', x: 10, y: 70, layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
			{ id: 'pin_3', x: 10, y: 90, layout: 'horizontal', functions: [{ name: 'SDA', type: 'i2c' }] },
			{ id: 'pin_4', x: 190, y: 50, layout: 'horizontal', functions: [{ name: 'SCL', type: 'i2c' }] }
		],
		spi: [
			{ id: 'pin_1', x: 10, y: 30, layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
			{ id: 'pin_2', x: 10, y: 50, layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
			{ id: 'pin_3', x: 10, y: 70, layout: 'horizontal', functions: [{ name: 'MOSI', type: 'spi' }] },
			{ id: 'pin_4', x: 10, y: 90, layout: 'horizontal', functions: [{ name: 'MISO', type: 'spi' }] },
			{ id: 'pin_5', x: 190, y: 30, layout: 'horizontal', functions: [{ name: 'SCK', type: 'spi' }] },
			{ id: 'pin_6', x: 190, y: 50, layout: 'horizontal', functions: [{ name: 'CS', type: 'digital' }] }
		],
		uart: [
			{ id: 'pin_1', x: 10, y: 50, layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
			{ id: 'pin_2', x: 10, y: 70, layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
			{ id: 'pin_3', x: 10, y: 90, layout: 'horizontal', functions: [{ name: 'TX', type: 'uart' }] },
			{ id: 'pin_4', x: 190, y: 50, layout: 'horizontal', functions: [{ name: 'RX', type: 'uart' }] }
		]
	}

	template.pins = pinTemplates[protocol || ''] || [
		{ id: 'pin_1', x: 10, y: 50, layout: 'horizontal', functions: [{ name: 'VCC', type: 'power' }] },
		{ id: 'pin_2', x: 10, y: 70, layout: 'horizontal', functions: [{ name: 'GND', type: 'gnd' }] },
		{ id: 'pin_3', x: 10, y: 90, layout: 'horizontal', functions: [{ name: 'DATA', type: 'digital' }] }
	]

	return template
}
