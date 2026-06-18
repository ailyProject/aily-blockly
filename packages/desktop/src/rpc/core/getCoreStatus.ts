import { p } from '../../trpc'

export const getCoreStatus = p.query(async ({ ctx }) => ctx.coreService.getStatus())
