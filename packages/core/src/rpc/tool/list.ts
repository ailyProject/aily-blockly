import { discoverChildTools } from '../../tool'
import { p } from '../trpc'
import { childToolListSchema } from './schemas'

export const list = p
	.input(childToolListSchema)
	.query(({ input }) => discoverChildTools({ childPath: input.childPath }))
