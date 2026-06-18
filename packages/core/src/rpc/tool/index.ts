import { r } from '../trpc'
import { get } from './get'
import { list } from './list'

export default r({
	get,
	list
})
