import { listHardwareProbeRs } from '../../hardware'
import { p } from '../trpc'

export default p.query(() => listHardwareProbeRs())
