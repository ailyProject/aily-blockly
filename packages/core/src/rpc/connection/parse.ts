import { z } from 'zod'

import { parseConnectionGraphJson } from '../../connection'
import { p } from '../trpc'

export default p.input(z.object({ raw: z.string() })).query(({ input }) => parseConnectionGraphJson(input.raw))
