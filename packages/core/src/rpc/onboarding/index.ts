import { r } from '../trpc'
import { default as completeOnboarding } from './completeOnboarding'
import { default as getOnboarding } from './getOnboarding'

export default r({
	getOnboarding,
	completeOnboarding
})
