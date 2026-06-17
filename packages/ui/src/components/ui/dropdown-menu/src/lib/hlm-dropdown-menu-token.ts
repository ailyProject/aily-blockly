import { inject, InjectionToken } from '@angular/core'
import { type MenuAlign, type MenuSide } from '@spartan-ng/brain/core'

import type { ValueProvider } from '@angular/core'

export interface HlmDropdownMenuConfig {
	align: MenuAlign
	side: MenuSide
}

const defaultConfig: HlmDropdownMenuConfig = {
	align: 'start',
	side: 'bottom'
}

const HlmDropdownMenuConfigToken = new InjectionToken<HlmDropdownMenuConfig>('HlmDropdownMenuConfig')

export function provideHlmDropdownMenuConfig(config: Partial<HlmDropdownMenuConfig>): ValueProvider {
	return { provide: HlmDropdownMenuConfigToken, useValue: { ...defaultConfig, ...config } }
}

export function injectHlmDropdownMenuConfig(): HlmDropdownMenuConfig {
	return inject(HlmDropdownMenuConfigToken, { optional: true }) ?? defaultConfig
}
