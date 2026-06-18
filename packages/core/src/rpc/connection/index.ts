import { r } from '../trpc'
import { default as collectConfigs } from './componentConfigs'
import { default as generatePinSummariesForBoard } from './generatePinSummariesForBoard'
import { default as getBoardPinSummary } from './getBoardPinSummary'
import { default as getLibraryInfo } from './getLibraryInfo'
import { default as getPinmapTemplate } from './getPinmapTemplate'
import { default as getPinSummaryById } from './getPinSummaryById'
import { default as getSensorPickerData } from './getSensorPickerData'
import { default as hasAws } from './hasAws'
import { default as hasGraph } from './hasGraph'
import { default as listAvailablePinmapIds } from './listAvailablePinmapIds'
import { default as listCatalogs } from './listCatalogs'
import { default as listLibraries } from './listLibraries'
import { default as parse } from './parse'
import { default as resolvePaths } from './paths'
import { default as buildPrompt } from './prompt'
import { default as readAws } from './readAws'
import { default as readGraph } from './readGraph'
import { default as syncCloudPinmaps } from './remote'
import { default as saveAws } from './saveAws'
import { default as saveGraph } from './saveGraph'
import { default as savePinmap } from './savePinmap'
import { default as validate } from './validate'

export default r({
	buildPrompt,
	collectConfigs,
	generatePinSummariesForBoard,
	getBoardPinSummary,
	getPinSummaryById,
	getLibraryInfo,
	getPinmapTemplate,
	getSensorPickerData,
	listAvailablePinmapIds,
	listCatalogs,
	listLibraries,
	hasAws,
	hasGraph,
	parse,
	readAws,
	readGraph,
	resolvePaths,
	saveAws,
	saveGraph,
	savePinmap,
	syncCloudPinmaps,
	validate
})
