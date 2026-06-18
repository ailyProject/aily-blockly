import { z } from 'zod'

import { generatePinSummaries, loadPinSummaryById, readBoardPinSummary } from '../../connection'
import { p } from '../trpc'

export const getBoardPinSummary = p
	.input(z.object({ boardPackagePath: z.string() }))
	.query(({ input }) => readBoardPinSummary(input.boardPackagePath))

export const getPinSummaryById = p
	.input(z.object({ fullId: z.string(), packagesBasePath: z.string() }))
	.query(({ input }) => loadPinSummaryById(input.fullId, input.packagesBasePath))

export const generatePinSummariesForBoard = p
	.input(
		z.object({
			boardPackagePath: z.string(),
			peripheralConfigPaths: z.array(z.string()).optional()
		})
	)
	.query(({ input }) => generatePinSummaries(input.boardPackagePath, input.peripheralConfigPaths))
