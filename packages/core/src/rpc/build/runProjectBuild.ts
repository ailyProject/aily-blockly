import { runProjectBuild } from '../../build'
import { p } from '../trpc'
import { projectBuildInputSchema } from './schemas'

/**
 * 执行项目预处理与编译流程。
 */
export default p.input(projectBuildInputSchema).mutation(({ input }) => runProjectBuild(input))
