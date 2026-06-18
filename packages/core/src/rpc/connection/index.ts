import { r } from '../trpc'
import { getSensorPickerData, listAvailablePinmapIds, listCatalogs, listLibraries } from './catalog'
import { collectConfigs } from './componentConfigs'
import { parse } from './parse'
import { resolvePaths } from './paths'
import { getLibraryInfo, getPinmapTemplate, savePinmap } from './pinmapPersistence'
import { generatePinSummariesForBoard, getBoardPinSummary, getPinSummaryById } from './pinSummary'
import { buildPrompt } from './prompt'
import { syncCloudPinmaps } from './remote'
import { hasAws, hasGraph, readAws, readGraph, saveAws, saveGraph } from './storage'
import { validate } from './validate'

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
