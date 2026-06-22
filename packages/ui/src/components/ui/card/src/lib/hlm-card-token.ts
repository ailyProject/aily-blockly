import { inject, InjectionToken } from '@angular/core'

import type { ValueProvider } from '@angular/core'

export type HlmCardConfig = {
	size: 'sm' | 'default'
}

const defaultConfig: HlmCardConfig = {
	size: 'default'
}

const HlmCardConfigToken = new InjectionToken<HlmCardConfig>('HlmCardConfig')

export function provideHlmCardConfig(config: Partial<HlmCardConfig>): ValueProvider {
	return { provide: HlmCardConfigToken, useValue: { ...defaultConfig, ...config } }
}

export function injectHlmCardConfig(): HlmCardConfig {
	return inject(HlmCardConfigToken, { optional: true }) ?? defaultConfig
}
