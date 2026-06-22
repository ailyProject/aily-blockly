import { prepareHardwareBleUpload } from '../../hardware'
import { p } from '../trpc'
import { hardwarePrepareBleUploadInputSchema } from './schemas'

/**
 * 生成 BLE OTA 上传执行计划。
 */
export default p.input(hardwarePrepareBleUploadInputSchema).mutation(({ input }) => prepareHardwareBleUpload(input))
