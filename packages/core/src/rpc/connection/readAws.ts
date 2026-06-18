import { z } from 'zod'

import { readConnectionAws } from '../../connection'
import { p } from '../trpc'

export default p.input(z.object({ projectPath: z.string() })).query(({ input }) => readConnectionAws(input.projectPath))
