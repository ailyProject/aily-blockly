import { Component, inject, OnInit, signal } from '@angular/core'
import { Router, RouterOutlet } from '@angular/router'

import { APP_ICON_IMPORTS, APP_ICON_PROVIDERS } from '@/components/ui/icon/app-icons'
import { getCurrentProjectPath } from '@/runtime/project-session'
import { getThemeMode, toggleThemeMode } from '@/runtime/theme'
import {
	closeDesktopWindow,
	getDesktop,
	getDesktopWindowState,
	loadDesktopHostRuntimeInfo,
	minimizeDesktopWindow,
	toggleDesktopWindowMaximize
} from '@/utils/desktop'

import type { DesktopHostRuntimeInfo, DesktopWindowStateResult } from '@desktop'

@Component({
	selector: 'main-page',
	imports: [RouterOutlet, ...APP_ICON_IMPORTS],
	providers: [...APP_ICON_PROVIDERS],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class MainPageComponent implements OnInit {
	private readonly router = inject(Router)

	protected readonly isWindowMaximized = signal(false)
	protected readonly themeMode = signal(getThemeMode())
	protected readonly runtimeInfo = signal<DesktopHostRuntimeInfo | null>(null)

	private get desktop() {
		return getDesktop()
	}

	async ngOnInit() {
		const desktop = this.desktop
		if (desktop) {
			this.runtimeInfo.set(await loadDesktopHostRuntimeInfo(desktop).catch(() => null))
		}
		await this.refreshWindowState()
	}

	protected get currentProjectLabel(): string {
		const currentProjectPath = getCurrentProjectPath().trim()
		if (!currentProjectPath) return 'aily blockly'

		const segments = currentProjectPath.split(/[\\/]/).filter(Boolean)
		return segments.at(-1) ?? ''
	}

	protected get isMac(): boolean {
		return this.runtimeInfo()?.platform === 'macos' || navigator.platform.toLowerCase().includes('mac')
	}

	protected get isGuideRoute(): boolean {
		return this.router.url.startsWith('/main/guide') || this.router.url === '/main'
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
		const desktop = this.desktop
		if (!desktop) return
		await minimizeDesktopWindow(desktop).catch(() => null)
	}

	protected async toggleWindowMaximize() {
		const desktop = this.desktop
		if (!desktop) return
		const result = await toggleDesktopWindowMaximize(desktop).catch(() => null)
		if (result?.available) {
			this.isWindowMaximized.set(result.isMaximized)
			return
		}

		await this.refreshWindowState()
	}

	protected async closeWindow() {
		const desktop = this.desktop
		if (!desktop) return
		await closeDesktopWindow(desktop).catch(() => null)
	}

	private async refreshWindowState() {
		const desktop = this.desktop
		if (!desktop) return

		const state = (await getDesktopWindowState(desktop).catch(() => null)) as DesktopWindowStateResult | null
		if (!state?.available) return

		this.isWindowMaximized.set(state.isMaximized)
	}
}
