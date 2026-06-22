import { r } from '../trpc'
import { default as cancelProjectBuild } from './cancelProjectBuild'
import { default as planProjectBuild } from './planProjectBuild'
import { default as prepareProjectBuild } from './prepareProjectBuild'
import { default as runProjectBuild } from './runProjectBuild'

export * from './schemas'

export default r({
	cancelProjectBuild,
	planProjectBuild,
	prepareProjectBuild,
	runProjectBuild
})
