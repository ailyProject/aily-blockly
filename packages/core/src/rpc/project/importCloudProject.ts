import { importCloudProjectArchive } from '../../project'
import { p } from '../trpc'
import { importCloudProjectSchema } from './schemas'

/**
 * 下载云项目归档并导入到目标目录。
 */
export default p.input(importCloudProjectSchema).mutation(({ input }) => importCloudProjectArchive(input))
