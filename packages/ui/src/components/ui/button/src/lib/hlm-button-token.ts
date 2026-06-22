import { inject, InjectionToken } from '@angular/core'

import type { ValueProvider } from '@angular/core'
import type { ButtonVariants } from './hlm-button'

export interface BrnButtonConfig {
	variant: ButtonVariants['variant']
	size: ButtonVariants['size']
}

const defaultConfig: BrnButtonConfig = {
	variant: 'default',
	size: 'default'
}

const BrnButtonConfigToken = new InjectionToken<BrnButtonConfig>('BrnButtonConfig')

export function provideBrnButtonConfig(config: Partial<BrnButtonConfig>): ValueProvider {
	return { provide: BrnButtonConfigToken, useValue: { ...defaultConfig, ...config } }
}

export function injectBrnButtonConfig(): BrnButtonConfig {
	return inject(BrnButtonConfigToken, { optional: true }) ?? defaultConfig
}
