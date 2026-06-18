import { discoverChildTools } from '../../tool'
import { p } from '../trpc'
import { childToolListSchema } from './schemas'

export default p.input(childToolListSchema).query(({ input }) => discoverChildTools({ childPath: input.childPath }))
