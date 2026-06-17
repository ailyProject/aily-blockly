import { HlmProgress } from './lib/hlm-progress'
import { HlmProgressIndicator } from './lib/hlm-progress-indicator'

export * from './lib/hlm-progress'
export * from './lib/hlm-progress-indicator'

export const HlmProgressImports = [HlmProgress, HlmProgressIndicator] as const
