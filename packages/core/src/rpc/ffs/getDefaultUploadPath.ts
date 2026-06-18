import { z } from 'zod'

import { getDefaultFfsUploadPath } from '../../ffs'
import { p } from '../trpc'
import { ffsFilesystemTypeSchema } from './schemas'

export default p
	.input(
		z.object({
			fileName: z.string(),
			type: ffsFilesystemTypeSchema
		})
	)
	.query(({ input }) => getDefaultFfsUploadPath(input.fileName, input.type))
