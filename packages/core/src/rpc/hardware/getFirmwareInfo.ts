import { z } from 'zod'

import { getHardwareFirmwareInfo } from '../../hardware'
import { appSchema, normalizeAppConfigInput } from '../config/schemas'
import { p } from '../trpc'

export const getFirmwareInfo = p
	.input(
		z.object({
			config: appSchema.partial().optional(),
			firmwareType: z.enum(['sscma_xiao_ai_s3', 'xiao_audio', 'xiao_vibrate']),
			version: z.string().nullable().optional()
		})
	)
	.query(({ input }) =>
		getHardwareFirmwareInfo({
			config: normalizeAppConfigInput(input.config),
			firmwareType: input.firmwareType,
			version: input.version
		})
	)
