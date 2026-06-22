import { updateCloudProject } from '../../cloud'
import { p } from '../trpc'
import { cloudProjectUpdateSchema } from './schemas'

/**
 * 更新云项目基础元数据。
 */
export default p.input(cloudProjectUpdateSchema).mutation(({ input }) => updateCloudProject(input))
