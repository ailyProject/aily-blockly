import { planHardwareUpload, resolveHardwareUploadContext } from '../../hardware'
import { p } from '../trpc'
import { hardwareRunUploadInputSchema } from './schemas'

/**
 * 预览当前项目的上传步骤。
 */
export default p.input(hardwareRunUploadInputSchema).query(({ input }) => {
	const context = resolveHardwareUploadContext(input)
	return planHardwareUpload(input, context)
})
