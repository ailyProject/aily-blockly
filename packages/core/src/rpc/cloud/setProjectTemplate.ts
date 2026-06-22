import { z } from 'zod'

import { setCloudProjectTemplate } from '../../cloud'
import { p } from '../trpc'
import { cloudProjectMutationSchema } from './schemas'

export default p
	.input(cloudProjectMutationSchema)
	.mutation(({ input }) => setCloudProjectTemplate(input.projectId, input.authToken))
