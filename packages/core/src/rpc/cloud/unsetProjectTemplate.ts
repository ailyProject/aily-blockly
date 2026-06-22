import { z } from 'zod'

import { unsetCloudProjectTemplate } from '../../cloud'
import { p } from '../trpc'
import { cloudProjectMutationSchema } from './schemas'

export default p
	.input(cloudProjectMutationSchema)
	.mutation(({ input }) => unsetCloudProjectTemplate(input.projectId, input.authToken))
