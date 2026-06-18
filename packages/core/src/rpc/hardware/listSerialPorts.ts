import { listHardwareSerialPorts } from '../../hardware'
import { p } from '../trpc'

export const listSerialPorts = p.query(() => listHardwareSerialPorts())
