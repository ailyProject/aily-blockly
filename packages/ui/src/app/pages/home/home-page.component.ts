import { Component, signal } from '@angular/core'
import { HlmAlertImports } from '@spartan-ng/helm/alert'
import { HlmBadgeImports } from '@spartan-ng/helm/badge'
import { HlmButtonImports } from '@spartan-ng/helm/button'
import { HlmCardImports } from '@spartan-ng/helm/card'
import { HlmInputImports } from '@spartan-ng/helm/input'
import { HlmSeparatorImports } from '@spartan-ng/helm/separator'
import { HlmTabsImports } from '@spartan-ng/helm/tabs'
import { APP_ICON_IMPORTS } from '@ui/components/ui/icon/app-icons'
import { AppShellComponent } from '@ui/layout/app-shell.component'
import { bottomTabItems, inspectorCards, navigationCards } from '@ui/pages/home/home-page.data'
import { applyThemeMode, getThemeMode, toggleThemeMode } from '@ui/runtime/theme'

@Component({
	selector: 'home-page',
	imports: [
		AppShellComponent,
		HlmAlertImports,
		HlmBadgeImports,
		HlmButtonImports,
		HlmCardImports,
		HlmInputImports,
		HlmSeparatorImports,
		HlmTabsImports,
		...APP_ICON_IMPORTS
	],
	templateUrl: './home-page.component.html',
	styleUrl: './home-page.component.css'
})
export class HomePageComponent {
	protected readonly bottomTab = signal('logs')
	protected readonly themeMode = signal(getThemeMode())
	protected readonly tabItems = bottomTabItems
	protected readonly navigationCards = navigationCards
	protected readonly inspectorCards = inspectorCards

	protected handleThemeToggle() {
		this.themeMode.set(toggleThemeMode())
	}

	protected useDarkMode() {
		this.themeMode.set(applyThemeMode('dark'))
	}

	protected get themeActionLabel() {
		return this.themeMode() === 'dark' ? 'Switch to light' : 'Switch to dark'
	}
}
