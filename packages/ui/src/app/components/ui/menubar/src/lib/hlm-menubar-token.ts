import { inject, InjectionToken } from '@angular/core'
import { type MenuAlign, type MenuSide } from '@spartan-ng/brain/core'

import type { ValueProvider } from '@angular/core'

export interface HlmMenubarConfig {
	align: MenuAlign
	side: MenuSide
}

const defaultConfig: HlmMenubarConfig = {
	align: 'start',
	side: 'bottom'
}

const HlmMenubarConfigToken = new InjectionToken<HlmMenubarConfig>('HlmMenubarConfig')

export function provideHlmMenubarConfig(config: Partial<HlmMenubarConfig>): ValueProvider {
	return { provide: HlmMenubarConfigToken, useValue: { ...defaultConfig, ...config } }
}

export function injectHlmMenubarConfig(): HlmMenubarConfig {
	return inject(HlmMenubarConfigToken, { optional: true }) ?? defaultConfig
}
