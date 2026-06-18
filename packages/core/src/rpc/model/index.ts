import { r } from '../trpc'
import { default as detail } from './detail'
import { default as list } from './list'

export default r({
	list,
	detail
})
