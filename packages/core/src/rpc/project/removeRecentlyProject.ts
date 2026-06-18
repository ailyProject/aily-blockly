import { z } from 'zod'

import { removeRecentlyProject as removeRecentProjectEntry } from '../../project'
import { p } from '../trpc'
import { recentProjectSchema } from './schemas'

export default p
	.input(z.object({ current: z.array(recentProjectSchema), path: z.string() }))
	.query(({ input }) => removeRecentProjectEntry(input.current, input.path))
