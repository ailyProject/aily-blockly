import { r } from '../trpc'
import { getSensorPickerData, listAvailablePinmapIds, listCatalogs, listLibraries } from './catalog'
import { collectConfigs } from './componentConfigs'
import { parse } from './parse'
import { resolvePaths } from './paths'
import { generatePinSummariesForBoard, getBoardPinSummary, getPinSummaryById } from './pinSummary'
import { buildPrompt } from './prompt'
import { validate } from './validate'

export default r({
	buildPrompt,
	collectConfigs,
	generatePinSummariesForBoard,
	getBoardPinSummary,
	getPinSummaryById,
	getSensorPickerData,
	listAvailablePinmapIds,
	listCatalogs,
	listLibraries,
	parse,
	resolvePaths,
	validate
})
