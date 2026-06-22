import { runHardwareUpload } from '../../hardware'
import { p } from '../trpc'
import { hardwareRunUploadInputSchema } from './schemas'

/**
 * 执行当前项目的上传链路。
 */
export default p.input(hardwareRunUploadInputSchema).mutation(({ input }) => runHardwareUpload(input))
