import { Component, input } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'
import { HlmInputImports } from 'spartan/input'

import { APP_ICON_IMPORTS } from '@/components/ui/icon/app-icons'

/**
 * 首页左侧导航栏。
 */
@Component({
	selector: 'home-navigation-rail',
	imports: [HlmBadgeImports, HlmCardImports, HlmInputImports, ...APP_ICON_IMPORTS],
	templateUrl: './navigation-rail.component.html',
	styleUrl: './navigation-rail.component.css'
})
export class HomeNavigationRailComponent {
	readonly navigationCards =
		input.required<Array<{ title: string; detail: string; tone: 'default' | 'secondary' | 'outline' }>>()
}
