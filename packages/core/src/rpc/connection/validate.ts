import { validateConnectionGraph } from '../../connection'
import { p } from '../trpc'
import { connectionGraphSchema } from './schemas'

export const validate = p.input(connectionGraphSchema).query(({ input }) => validateConnectionGraph(input))
