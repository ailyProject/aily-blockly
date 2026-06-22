import { Component, input } from '@angular/core'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'
import { HlmSeparatorImports } from 'spartan/separator'

import { APP_ICON_IMPORTS } from '@/components/ui/icon/app-icons'

/**
 * 首页右侧工具栏。
 */
@Component({
	selector: 'home-inspector-rail',
	imports: [HlmBadgeImports, HlmCardImports, HlmSeparatorImports, ...APP_ICON_IMPORTS],
	templateUrl: './inspector-rail.component.html',
	styleUrl: './inspector-rail.component.css'
})
export class HomeInspectorRailComponent {
	readonly inspectorCards = input.required<Array<{ title: string; detail: string }>>()
}
