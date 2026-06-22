import { NgIcon, provideIcons } from '@ng-icons/core'
import {
	lucideBlocks,
	lucideBot,
	lucideChevronDown,
	lucideCpu,
	lucideFolderOpen,
	lucideMegaphone,
	lucideMenu,
	lucideMinus,
	lucideMoonStar,
	lucidePanelBottom,
	lucidePanelLeft,
	lucideSearch,
	lucideSlidersHorizontal,
	lucideSquare,
	lucideSunMedium,
	lucideTerminal,
	lucideX
} from '@ng-icons/lucide'

export const APP_ICON_IMPORTS = [NgIcon] as const

export const APP_ICON_PROVIDERS = [
	provideIcons({
		lucideBlocks,
		lucideBot,
		lucideChevronDown,
		lucideCpu,
		lucideFolderOpen,
		lucideMenu,
		lucideMegaphone,
		lucideMinus,
		lucideMoonStar,
		lucidePanelBottom,
		lucidePanelLeft,
		lucideSearch,
		lucideSquare,
		lucideSlidersHorizontal,
		lucideSunMedium,
		lucideTerminal,
		lucideX
	})
] as const
