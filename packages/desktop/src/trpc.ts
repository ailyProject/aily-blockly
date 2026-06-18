import { initTRPC } from '@trpc/server'

import type { DesktopMainContext } from './types'

const t = initTRPC.context<DesktopMainContext>().create({ isServer: true })

export const p = t.procedure
export const router = t.router
