import { prepareProjectBuild } from '../../build'
import { p } from '../trpc'
import { projectBuildInputSchema } from './schemas'

/**
 * 为项目构建准备 .temp 文件系统和命令计划。
 */
export default p.input(projectBuildInputSchema).mutation(({ input }) => prepareProjectBuild(input))
