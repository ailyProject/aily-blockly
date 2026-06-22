import { z } from 'zod'

import { getConnectionWorkspaceState } from '../../connection'
import { p } from '../trpc'

export default p
	.input(z.object({ projectPath: z.string() }))
	.query(({ input }) => getConnectionWorkspaceState(input.projectPath))
