import { z } from 'zod'

import { validateFfsUploadFileName } from '../../ffs'
import { p } from '../trpc'
import { ffsFilesystemTypeSchema } from './schemas'

export default p
	.input(
		z.object({
			fileName: z.string(),
			type: ffsFilesystemTypeSchema
		})
	)
	.query(({ input }) => validateFfsUploadFileName(input.fileName, input.type))
