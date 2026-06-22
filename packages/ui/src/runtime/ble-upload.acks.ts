import {
	ACK_OK,
	COMMAND_ACK_TIMEOUT_MS,
	formatBleAckError,
	getEventBytes,
	isValidFrame,
	readUint16LE,
	SECTOR_ACK_TIMEOUT_MS
} from './ble-upload.shared'

const waitForCharacteristicMatch = (
	target: { addEventListener: Function; removeEventListener: Function },
	timeoutMs: number,
	matches: (bytes: Uint8Array) => boolean,
	resolveResult: (bytes: Uint8Array) => void
) =>
	new Promise<void>((resolve, reject) => {
		let settled = false
		const cleanup = () => {
			target.removeEventListener('characteristicvaluechanged', listener)
			clearTimeout(timer)
		}
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			cleanup()
			reject(new Error('BLE ack timeout'))
		}, timeoutMs)
		const listener = (event: Event) => {
			const bytes = getEventBytes(event)
			if (!matches(bytes) || settled) return
			settled = true
			cleanup()
			try {
				resolveResult(bytes)
				resolve()
			} catch (error) {
				reject(error)
			}
		}
		target.addEventListener('characteristicvaluechanged', listener)
	})

/**
 * 等待 BLE command characteristic 返回 ACK。
 * @param command - command characteristic
 * @param commandId - 目标命令 ID
 */
export const waitForBleCommandAck = (
	command: { addEventListener: Function; removeEventListener: Function },
	commandId: number
) =>
	waitForCharacteristicMatch(
		command,
		COMMAND_ACK_TIMEOUT_MS,
		bytes => isValidFrame(bytes) && readUint16LE(bytes, 0) === 0x0003 && readUint16LE(bytes, 2) === commandId,
		bytes => {
			const status = readUint16LE(bytes, 4)
			if (status !== ACK_OK) {
				throw new Error(formatBleAckError(status, commandId))
			}
		}
	)

/**
 * 等待 BLE 数据 characteristic 返回某个扇区的 ACK。
 * @param recv - firmware data characteristic
 * @param sectorIndex - 目标扇区索引
 */
export const waitForBleSectorAck = (
	recv: { addEventListener: Function; removeEventListener: Function },
	sectorIndex: number
) =>
	waitForCharacteristicMatch(
		recv,
		SECTOR_ACK_TIMEOUT_MS,
		bytes => isValidFrame(bytes) && readUint16LE(bytes, 0) === sectorIndex,
		bytes => {
			const status = readUint16LE(bytes, 2)
			if (status !== ACK_OK) {
				throw new Error(formatBleAckError(status))
			}
		}
	)
