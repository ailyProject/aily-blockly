import { getChildTool } from '../../tool'
import { p } from '../trpc'
import { childToolGetSchema } from './schemas'

export const get = p
	.input(childToolGetSchema)
	.query(({ input }) => getChildTool(input.toolId, { childPath: input.childPath }))
