import { cancelHardwareUpload } from '../../hardware'
import { p } from '../trpc'

/**
 * 取消当前上传流程。
 */
export default p.mutation(() => cancelHardwareUpload())
