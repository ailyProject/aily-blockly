import { z } from 'zod'

import { focusDesktopProjectOpenProcess } from '../../project-open'
import { p } from '../../trpc'

import type { DesktopFocusProcessResult } from '../types'

/**
 * 尝试把指定桌面进程前置到最前。
 */
export default p
	.input(
		z.object({
			pid: z.number().int().positive()
		})
	)
	.mutation(async ({ ctx, input }): Promise<DesktopFocusProcessResult> => {
		const result = await focusDesktopProjectOpenProcess(ctx.event, input.pid)
		return {
			available: true,
			...result
		}
	})
