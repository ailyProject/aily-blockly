import { listHardwareSerialPorts } from '../../hardware'
import { p } from '../trpc'

export default p.query(() => listHardwareSerialPorts())
