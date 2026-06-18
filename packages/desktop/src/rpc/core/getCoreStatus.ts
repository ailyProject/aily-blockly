import { p } from '../../trpc'

export default p.query(async ({ ctx }) => ctx.coreService.getStatus())
