import { z } from 'zod'

import { deleteCloudProject } from '../../cloud'
import { p } from '../trpc'
import { cloudProjectMutationSchema } from './schemas'

export default p
	.input(cloudProjectMutationSchema)
	.mutation(({ input }) => deleteCloudProject(input.projectId, input.authToken))
