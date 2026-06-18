import { Component } from '@angular/core'
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router'
import { HlmCardImports } from 'spartan/card'
import { HlmSeparatorImports } from 'spartan/separator'

import { AppShellComponent } from '@/layout/app-shell.component'

import { primaryRouteLinks, utilityRouteLinks } from './main-page.data'

@Component({
	selector: 'main-page',
	imports: [AppShellComponent, HlmCardImports, HlmSeparatorImports, RouterLink, RouterLinkActive, RouterOutlet],
	templateUrl: './main-page.component.html',
	styleUrl: './main-page.component.css'
})
export class MainPageComponent {
	protected readonly primaryRouteLinks = primaryRouteLinks
	protected readonly utilityRouteLinks = utilityRouteLinks
}
