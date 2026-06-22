import { Component, inject, OnInit, signal } from '@angular/core'
import { Router, RouterOutlet } from '@angular/router'

import { APP_ICON_IMPORTS, APP_ICON_PROVIDERS } from '@/components/ui/icon/app-icons'
import { getCurrentProjectPath } from '@/runtime/project-session'
import { getThemeMode, toggleThemeMode } from '@/runtime/theme'
import {
	closeDesktopWindow,
	getDesktop,
	getDesktopWindowState,
	minimizeDesktopWindow,
	toggleDesktopWindowMaximize
} from '@/utils/desktop'

import type { DesktopWindowStateResult } from '@desktop'

@Component({
	selector: 'main-page',
	imports: [RouterOutlet, ...APP_ICON_IMPORTS],
	providers: [...APP_ICON_PROVIDERS],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class MainPageComponent implements OnInit {
	private readonly desktop = getDesktop()
	private readonly router = inject(Router)

	protected readonly isWindowMaximized = signal(false)
	protected readonly themeMode = signal(getThemeMode())

	async ngOnInit() {
		await this.refreshWindowState()
	}

	protected get currentProjectLabel(): string {
		const currentProjectPath = getCurrentProjectPath().trim()
		if (!currentProjectPath) return ''

		const segments = currentProjectPath.split(/[\\/]/).filter(Boolean)
		return segments.at(-1) ?? ''
	}

	protected async navigateToGuide() {
		await this.router.navigate(['/main/guide'])
	}

	protected async navigateToProjectNew() {
		await this.router.navigate(['/main/project-new'])
	}

	protected async navigateToProjectOpen() {
		await this.router.navigate(['/main/project-open'])
	}

	protected async navigateToPlayground() {
		await this.router.navigate(['/main/playground'])
	}

	protected async navigateToChat() {
		await this.router.navigate(['/aily-chat'])
	}

	protected async openBottomTerminal() {
		await this.router.navigate(['/terminal'])
	}

	protected async openBottomLog() {
		await this.router.navigate(['/serial-monitor'])
	}

	protected toggleTheme() {
		this.themeMode.set(toggleThemeMode())
	}

	protected async minimizeWindow() {
		if (!this.desktop) return
		await minimizeDesktopWindow(this.desktop).catch(() => null)
	}

	protected async toggleWindowMaximize() {
		if (!this.desktop) return
		const result = await toggleDesktopWindowMaximize(this.desktop).catch(() => null)
		if (result?.available) {
			this.isWindowMaximized.set(result.isMaximized)
			return
		}

		await this.refreshWindowState()
	}

	protected async closeWindow() {
		if (!this.desktop) return
		await closeDesktopWindow(this.desktop).catch(() => null)
	}

	private async refreshWindowState() {
		if (!this.desktop) return

		const state = (await getDesktopWindowState(this.desktop).catch(() => null)) as DesktopWindowStateResult | null
		if (!state?.available) return

		this.isWindowMaximized.set(state.isMaximized)
	}
}
