import type { UploadErrorCode } from 'shared'

export type BleCharacteristic = {
	startNotifications(): Promise<unknown>
	addEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void
	removeEventListener(type: 'characteristicvaluechanged', listener: (event: Event) => void): void
	writeValueWithoutResponse?(value: BufferSource): Promise<void>
	writeValueWithResponse?(value: BufferSource): Promise<void>
	writeValue(value: BufferSource): Promise<void>
}

export type BleServer = {
	getPrimaryService(uuid: string): Promise<{ getCharacteristic(uuid: string): Promise<BleCharacteristic> }>
}

export type BleGatt = {
	connected: boolean
	connect(): Promise<BleServer>
	disconnect(): void
}

export type BleDevice = {
	id: string
	name?: string
	gatt?: BleGatt
}

/**
 * UI 侧 BLE OTA 传输进度。
 */
export interface BleOtaExecutionProgress {
	/** 当前阶段。 */
	phase: 'starting' | 'sending' | 'stopping' | 'done' | 'error'
	/** 当前进度百分比。 */
	progress: number
	/** 当前阶段文案。 */
	text: string
	/** 已确认完成的分片数。 */
	acknowledgedPackets?: number
	/** 总分片数。 */
	totalPackets?: number
}

/**
 * UI 侧 BLE OTA 执行结果。
 */
export interface BleOtaExecutionResult {
	/** 当前是否成功。 */
	success: boolean
	/** 统一错误码。 */
	errorCode?: UploadErrorCode
	/** 面向用户的消息。 */
	message?: string
	/** 已确认完成的分片数。 */
	progressEventCount: number
	/** 最近阶段摘要。 */
	latestProgressText: string
}
