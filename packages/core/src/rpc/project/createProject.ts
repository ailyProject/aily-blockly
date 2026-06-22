import { z } from 'zod'

import { createProject } from '../../project'
import { p } from '../trpc'

/**
 * 创建一个新的空白项目。
 */
export default p
	.input(
		z.object({
			appDataPath: z.string(),
			projectPath: z.string(),
			name: z.string(),
			nickname: z.string().optional(),
			description: z.string().optional(),
			boardName: z.string(),
			boardDisplayName: z.string().optional(),
			boardVersion: z.string().optional(),
			devmode: z.string().optional()
		})
	)
	.mutation(({ input }) => createProject(input))
