import { NgIcon, provideIcons } from '@ng-icons/core'
import {
	lucideBlocks,
	lucideBot,
	lucideCpu,
	lucideFolderOpen,
	lucideMoonStar,
	lucidePanelBottom,
	lucidePanelLeft,
	lucideSearch,
	lucideSlidersHorizontal,
	lucideSunMedium,
	lucideTerminal
} from '@ng-icons/lucide'

export const APP_ICON_IMPORTS = [NgIcon] as const

export const APP_ICON_PROVIDERS = [
	provideIcons({
		lucideBlocks,
		lucideBot,
		lucideCpu,
		lucideFolderOpen,
		lucideMoonStar,
		lucidePanelBottom,
		lucidePanelLeft,
		lucideSearch,
		lucideSlidersHorizontal,
		lucideSunMedium,
		lucideTerminal
	})
] as const
