import { z } from 'zod'

import { unpublishCloudProject } from '../../cloud'
import { p } from '../trpc'
import { cloudProjectMutationSchema } from './schemas'

export default p
	.input(cloudProjectMutationSchema)
	.mutation(({ input }) => unpublishCloudProject(input.projectId, input.authToken))
