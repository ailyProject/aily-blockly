import { r } from '../trpc'
import { default as collectConfigs } from './componentConfigs'
import { default as getLibraryInfo } from './getLibraryInfo'
import { default as getPinmapTemplate } from './getPinmapTemplate'
import { default as getSensorPickerData } from './getSensorPickerData'
import { default as getWorkspaceState } from './getWorkspaceState'
import { default as listAvailablePinmapIds } from './listAvailablePinmapIds'
import { default as listCatalogs } from './listCatalogs'
import { default as listLibraries } from './listLibraries'
import { default as buildPrompt } from './prompt'
import { default as readAws } from './readAws'
import { default as readGraph } from './readGraph'
import { default as syncCloudPinmaps } from './remote'
import { default as saveAws } from './saveAws'
import { default as saveGraph } from './saveGraph'
import { default as savePinmap } from './savePinmap'

export default r({
	buildPrompt,
	collectConfigs,
	getLibraryInfo,
	getPinmapTemplate,
	getSensorPickerData,
	getWorkspaceState,
	listAvailablePinmapIds,
	listCatalogs,
	listLibraries,
	readAws,
	readGraph,
	saveAws,
	saveGraph,
	savePinmap,
	syncCloudPinmaps
})
