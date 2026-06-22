export type {
	BoardIndexItem,
	CategoryCount,
	LegacyBoardItem,
	LegacyLibraryItem,
	LibraryIndexItem
} from './hardware/types'
export type { FfsPartitionInfo } from './ffs/types'
export type { HardwareFirmwareType } from './hardware/firmware/types'
export type { HardwareEsptoolPlatform } from './hardware/esptool/types'
export type { Router } from './rpc/types'
export type { ChildToolHostInfo, ChildToolItem, CloudProjectListResult, CloudProjectSummary } from 'shared'
export type {
	SerialMessageDirection,
	SerialSendInput,
	SerialSendMode,
	SerialSendPayloadInput,
	SerialSendResult,
	SerialSessionMessage,
	SerialSessionSnapshot,
	SerialSignalInput,
	SerialSignalKind,
	SerialSignalResult
} from './serial/types'

const maybeStartStandalone = async () => {
	if (typeof process === 'undefined' || !process.argv[1]) return

	const [{ resolve }, { fileURLToPath }] = await Promise.all([import('node:path'), import('node:url')])
	if (resolve(process.argv[1]) !== fileURLToPath(import.meta.url)) return

	await import('./rpc/standalone')
}

void maybeStartStandalone()
