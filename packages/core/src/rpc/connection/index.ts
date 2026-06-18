import { r } from '../trpc'
import { parse } from './parse'
import { resolvePaths } from './paths'
import { validate } from './validate'

export default r({
	parse,
	resolvePaths,
	validate
})
