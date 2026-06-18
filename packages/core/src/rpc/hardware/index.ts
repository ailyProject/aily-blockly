import { r } from '../trpc'
import { default as detectEsptool } from './detectEsptool'
import { default as downloadProbe } from './downloadProbe'
import { default as getBoardCategories } from './getBoardCategories'
import { default as getFirmwareInfo } from './getFirmwareInfo'
import { default as getLibraryCategories } from './getLibraryCategories'
import { default as getModelAddress } from './getModelAddress'
import { default as getModelFile } from './getModelFile'
import { default as installEsptool } from './installEsptool'
import { default as listProbes } from './listProbes'
import { default as listSerialPorts } from './listSerialPorts'
import { default as needFirmwareUpdate } from './needFirmwareUpdate'
import { default as resolveEsptoolTempDir } from './resolveEsptoolTempDir'
import { default as searchCompat } from './search'
import { default as validateLegacyBoard } from './validateLegacyBoard'
import { default as validateLegacyLibrary } from './validateLegacyLibrary'

export default r({
	validateLegacyBoard,
	validateLegacyLibrary,
	getBoardCategories,
	getLibraryCategories,
	searchCompat,
	listSerialPorts,
	getFirmwareInfo,
	getModelFile,
	getModelAddress,
	needFirmwareUpdate,
	detectEsptool,
	installEsptool,
	resolveEsptoolTempDir,
	listProbes,
	downloadProbe
})
