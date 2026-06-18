import { r } from '../trpc'
import { default as get } from './get'
import { default as list } from './list'

export default r({
	get,
	list
})
