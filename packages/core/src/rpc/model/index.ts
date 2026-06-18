import { r } from '../trpc'
import { detail } from './detail'
import { list } from './list'

export default r({
	list,
	detail
})
