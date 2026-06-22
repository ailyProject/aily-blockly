import { z } from 'zod'

import { publishCloudProject } from '../../cloud'
import { p } from '../trpc'
import { cloudProjectMutationSchema } from './schemas'

export default p
	.input(cloudProjectMutationSchema)
	.mutation(({ input }) => publishCloudProject(input.projectId, input.authToken))
