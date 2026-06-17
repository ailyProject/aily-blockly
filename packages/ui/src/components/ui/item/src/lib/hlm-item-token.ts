import { inject, InjectionToken } from '@angular/core'

import type { ValueProvider } from '@angular/core'
import type { ItemVariants } from './hlm-item'
import type { ItemMediaVariants } from './hlm-item-media'

export interface HlmItemConfig {
	variant: ItemVariants['variant']
	size: ItemVariants['size']
}

const defaultConfig: HlmItemConfig = {
	variant: 'default',
	size: 'default'
}

const HlmItemConfigToken = new InjectionToken<HlmItemConfig>('HlmItemConfig')

export function provideHlmItemConfig(config: Partial<HlmItemConfig>): ValueProvider {
	return { provide: HlmItemConfigToken, useValue: { ...defaultConfig, ...config } }
}

export function injectHlmItemConfig(): HlmItemConfig {
	return inject(HlmItemConfigToken, { optional: true }) ?? defaultConfig
}

export interface HlmItemMediaConfig {
	variant: ItemMediaVariants['variant']
}

const defaultMediaConfig: HlmItemMediaConfig = {
	variant: 'default'
}

const HlmItemMediaConfigToken = new InjectionToken<HlmItemMediaConfig>('HlmItemMediaConfig')

export function provideHlmItemMediaConfig(config: Partial<HlmItemMediaConfig>): ValueProvider {
	return { provide: HlmItemMediaConfigToken, useValue: { ...defaultMediaConfig, ...config } }
}

export function injectHlmItemMediaConfig(): HlmItemMediaConfig {
	return inject(HlmItemMediaConfigToken, { optional: true }) ?? defaultMediaConfig
}
