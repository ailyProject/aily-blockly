import { validateConnectionGraph } from '../../connection'
import { p } from '../trpc'
import { connectionGraphSchema } from './schemas'

export default p.input(connectionGraphSchema).query(({ input }) => validateConnectionGraph(input))
