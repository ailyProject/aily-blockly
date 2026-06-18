import type { PlaygroundSubjectItem } from './types'

export const playgroundSubjects: Array<PlaygroundSubjectItem> = [
	{
		id: 'starter',
		title: 'Starter Kits',
		summary: 'Beginner-friendly flows for board setup, serial output, and first block programs.',
		tag: 'Basics',
		examples: [
			{ id: 'hello-serial', title: 'Hello Serial', summary: 'Send text to the serial monitor.', board: 'XIAO ESP32S3' },
			{
				id: 'led-blink',
				title: 'LED Blink',
				summary: 'Blink the status LED with a timer block.',
				board: 'Arduino UNO R4'
			}
		]
	},
	{
		id: 'vision',
		title: 'Vision Workflows',
		summary: 'Model train and deploy oriented examples for camera-capable boards.',
		tag: 'Vision',
		examples: [
			{
				id: 'camera-stream',
				title: 'Camera Stream',
				summary: 'Prepare a camera stream pipeline.',
				board: 'XIAO ESP32S3'
			},
			{
				id: 'gesture-lite',
				title: 'Gesture Lite',
				summary: 'A small gesture classification workflow.',
				board: 'XIAO ESP32S3'
			}
		]
	},
	{
		id: 'iot',
		title: 'IoT Patterns',
		summary: 'Connectivity-oriented samples around MQTT, sensors, and cloud messaging.',
		tag: 'IoT',
		examples: [
			{ id: 'wifi-scan', title: 'Wi-Fi Scan', summary: 'List nearby SSIDs on boot.', board: 'XIAO ESP32S3' },
			{
				id: 'sensor-push',
				title: 'Sensor Push',
				summary: 'Publish sensor snapshots periodically.',
				board: 'Arduino UNO R4'
			}
		]
	}
]
