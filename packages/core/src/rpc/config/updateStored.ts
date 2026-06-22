import { z } from 'zod'

import { applyProjectConfigPatch, readProjectConfigFile, writeProjectConfigFile } from '../../project'
import { p } from '../trpc'
import { configPatchSchema } from './schemas'
import { resolveConfigSummary } from './summary'

/**
 * 把配置 patch 真实写回 `${appDataPath}/config.json`，并返回新的摘要。
 */
export default p
	.input(
		z.object({
			appDataPath: z.string(),
			fallbackLanguage: z.string().optional(),
			userHome: z.string().optional(),
			...configPatchSchema.shape
		})
	)
	.mutation(async ({ input }) => {
		const currentConfig = readProjectConfigFile({ appDataPath: input.appDataPath })
		const nextConfig = applyProjectConfigPatch(currentConfig, input)
		await writeProjectConfigFile({
			appDataPath: input.appDataPath,
			config: nextConfig
		})
		return resolveConfigSummary(nextConfig, input)
	})
