import { r } from '../trpc'
import { boardCategories, libraryCategories } from './categories'
import { detectEsptool } from './detectEsptool'
import { downloadProbe } from './downloadProbe'
import { getFirmwareInfo } from './getFirmwareInfo'
import { getModelAddress } from './getModelAddress'
import { getModelFile } from './getModelFile'
import { installEsptool } from './installEsptool'
import { validateBoard, validateLibrary } from './legacy'
import { listProbes } from './listProbes'
import { listSerialPorts } from './listSerialPorts'
import { needFirmwareUpdate } from './needFirmwareUpdate'
import { resolveEsptoolTempDir } from './resolveEsptoolTempDir'
import { searchCompat } from './search'

export default r({
	validateLegacyBoard: validateBoard,
	validateLegacyLibrary: validateLibrary,
	getBoardCategories: boardCategories,
	getLibraryCategories: libraryCategories,
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
