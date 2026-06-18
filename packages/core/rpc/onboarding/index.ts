import { r } from '../trpc'
import { completeOnboarding, getOnboarding } from './onboarding'

export default r({
	getOnboarding,
	completeOnboarding
})
