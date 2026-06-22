import { r } from '../trpc'
import { default as cancelUpload } from './cancelUpload'
import { default as detectEsptool } from './detectEsptool'
import { default as getBoardCategories } from './getBoardCategories'
import { default as getFirmwareInfo } from './getFirmwareInfo'
import { default as listProbes } from './listProbes'
import { default as listSerialPorts } from './listSerialPorts'
import { default as planUpload } from './planUpload'
import { default as prepareBleUpload } from './prepareBleUpload'
import { default as prepareUploadExecution } from './prepareUploadExecution'
import { default as runUpload } from './runUpload'
import { default as searchCompat } from './search'
import { default as validateLegacyBoard } from './validateLegacyBoard'
import { default as validateLegacyLibrary } from './validateLegacyLibrary'

export default r({
	cancelUpload,
	validateLegacyBoard,
	validateLegacyLibrary,
	getBoardCategories,
	searchCompat,
	listSerialPorts,
	getFirmwareInfo,
	planUpload,
	prepareBleUpload,
	prepareUploadExecution,
	detectEsptool,
	listProbes,
	runUpload
})
