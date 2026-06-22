import { cancelProjectBuild } from '../../build'
import { p } from '../trpc'

/**
 * 取消当前项目构建。
 */
export default p.mutation(() => cancelProjectBuild())
