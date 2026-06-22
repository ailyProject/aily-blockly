import { r } from '../trpc'
import { default as acquire } from './acquire'
import { default as list } from './list'
import { default as release } from './release'
import { default as restart } from './restart'

export default r({
	acquire,
	list,
	release,
	restart
})
