import { r } from '../trpc'
import { default as formatAbs } from './formatAbs'
import { default as fromAbs } from './fromAbs'
import { default as toAbs } from './toAbs'
import { default as validateAbs } from './validateAbs'

export default r({
	toAbs,
	fromAbs,
	formatAbs,
	validateAbs
})
