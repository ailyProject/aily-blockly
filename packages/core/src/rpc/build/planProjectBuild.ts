import { resolveProjectBuildPlan } from '../../build'
import { p } from '../trpc'
import { projectBuildInputSchema } from './schemas'

/**
 * 预览项目预处理与编译计划。
 */
export default p.input(projectBuildInputSchema).query(({ input }) => resolveProjectBuildPlan(input))
