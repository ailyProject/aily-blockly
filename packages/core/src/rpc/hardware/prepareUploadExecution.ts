import { prepareHardwareUploadExecution } from '../../hardware'
import { p } from '../trpc'
import { hardwareRunUploadInputSchema } from './schemas'

/**
 * 为上传链路准备构建结果、端口和最终命令，但不直接执行命令。
 */
export default p.input(hardwareRunUploadInputSchema).mutation(({ input }) => prepareHardwareUploadExecution(input))
