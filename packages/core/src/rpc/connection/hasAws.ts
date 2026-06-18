import { z } from 'zod'

import { hasConnectionAws } from '../../connection'
import { p } from '../trpc'

export default p.input(z.object({ projectPath: z.string() })).query(({ input }) => hasConnectionAws(input.projectPath))
