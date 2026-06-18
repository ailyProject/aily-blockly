import { listHardwareProbeRs } from '../../hardware'
import { p } from '../trpc'

export const listProbes = p.query(() => listHardwareProbeRs())
