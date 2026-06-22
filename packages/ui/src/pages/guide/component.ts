import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core'
import { Router } from '@angular/router'

import { APP_ICON_IMPORTS, APP_ICON_PROVIDERS } from '@/components/ui/icon/app-icons'
import { openProjectInEditor } from '@/runtime/project-routing'
import { getThemeMode } from '@/runtime/theme'
import { getCore } from '@/utils/core'
import { getDesktop, loadDesktopHostRuntimeInfo, selectDesktopProjectPath } from '@/utils/desktop'

import type { DesktopHostRuntimeInfo } from '@desktop'
import type { GuideRecentProject } from './types'

interface GuideActionItem {
	id: 'project-new' | 'project-open' | 'playground-open' | 'tool-open'
	label: string
	icon: 'lucideBlocks' | 'lucideFolderOpen' | 'lucideCpu' | 'lucideBot'
}

interface GuideSponsorItem {
	name: string
	company?: string
	url?: string
	img?: string
	imgLight?: string
}

@Component({
	selector: 'guide-page',
	imports: [...APP_ICON_IMPORTS],
	providers: [...APP_ICON_PROVIDERS],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class GuidePageComponent implements OnInit, OnDestroy {
	private readonly core = getCore()
	private readonly desktop = getDesktop()
	private readonly router = inject(Router)
	private sponsorCarouselTimer: ReturnType<typeof setTimeout> | null = null
	private sponsorResetTimer: ReturnType<typeof setTimeout> | null = null
	private readonly sponsorPageSize = 3
	private readonly sponsorPauseMs = 3000
	private readonly sponsorTransitionMs = 500

	protected readonly quickActions: Array<GuideActionItem> = [
		{ id: 'project-new', label: 'Create Project', icon: 'lucideBlocks' },
		{ id: 'project-open', label: 'Open Project', icon: 'lucideFolderOpen' },
		{ id: 'playground-open', label: 'Project Hub', icon: 'lucideCpu' },
		{ id: 'tool-open', label: 'AI Assistant', icon: 'lucideBot' }
	]
	protected readonly recentProjects = signal<Array<GuideRecentProject>>([])
	protected readonly language = signal('en_US')
	protected readonly onboardingCompleted = signal(false)
	protected readonly runtimeInfo = signal<DesktopHostRuntimeInfo | null>(null)
	protected readonly sponsors = signal<Array<GuideSponsorItem>>([])
	protected readonly sponsorPages = signal<Array<Array<GuideSponsorItem>>>([])
	protected readonly sponsorRenderPages = signal<Array<Array<GuideSponsorItem>>>([])
	protected readonly sponsorPageIndex = signal(0)
	protected readonly sponsorPageTransitionEnabled = signal(true)

	protected get logoSrc(): string {
		return getThemeMode() === 'light' ? 'imgs/logo-light.webp' : 'imgs/logo.webp'
	}

	protected get sensecraftImg(): string {
		return getThemeMode() === 'light' ? 'brands/sensecraft-light.webp' : 'brands/sensecraft.webp'
	}

	protected get guidePageIframeSrc(): string {
		return this.isCnRegion() ? 'https://guide-page.yiyu.pro' : 'https://guide-page.aily.pro'
	}

	protected readonly isCnRegion = () => this.language().toLowerCase().startsWith('zh')

	async ngOnInit() {
		const runtimeInfoPromise = this.desktop
			? loadDesktopHostRuntimeInfo(this.desktop).catch(() => null)
			: Promise.resolve(null)
		const [configSummary, onboarding, runtimeInfo] = await Promise.all([
			this.core.config.get.query({ fallbackLanguage: 'en_US' }),
			this.core.onboarding.getOnboarding.query({}),
			runtimeInfoPromise
		])
		const recentProjects = runtimeInfo?.appDataPath
			? await this.core.project.getStoredRecentProjects.query({ appDataPath: runtimeInfo.appDataPath }).catch(() => [])
			: await this.core.project.getRecentProjects.query({}).catch(() => [])

		this.language.set(configSummary.selectedLanguage)
		this.recentProjects.set(recentProjects)
		this.onboardingCompleted.set(onboarding.onboardingCompleted)
		this.runtimeInfo.set(runtimeInfo)
		await this.loadSponsors()
	}

	ngOnDestroy() {
		this.stopSponsorCarousel()
	}

	protected getSponsorImg(sponsor: GuideSponsorItem): string {
		if (getThemeMode() === 'light' && sponsor.imgLight) {
			return `sponsor/${sponsor.imgLight}`
		}

		return `sponsor/${sponsor.img}`
	}

	protected async onQuickAction(actionId: GuideActionItem['id']) {
		switch (actionId) {
			case 'project-new':
				await this.router.navigate(['/main/project-new'])
				return
			case 'project-open':
				await this.openProjectBySelection()
				return
			case 'playground-open':
				await this.router.navigate(['/main/playground'])
				return
			case 'tool-open':
				await this.router.navigate(['/aily-chat'])
				return
		}
	}

	protected async openProjectByPath(projectPath: string) {
		const resolvedPath = await this.core.project.resolveOpenPath.query({ path: projectPath }).catch(() => '')
		if (!resolvedPath) return

		await openProjectInEditor(this.core, this.router, resolvedPath)
	}

	protected async openProjectBySelection() {
		if (!this.desktop) {
			await this.router.navigate(['/main/project-open'])
			return
		}

		const selectedPath = await selectDesktopProjectPath(this.desktop, '').catch(() => '')
		if (!selectedPath) return

		await this.openProjectByPath(selectedPath)
	}

	protected async removeProject(event: Event, project: GuideRecentProject) {
		event.stopPropagation()

		const runtimeInfo = this.runtimeInfo()
		if (runtimeInfo?.appDataPath) {
			const recentProjects = await this.core.project.removeStoredRecentProject.mutate({
				appDataPath: runtimeInfo.appDataPath,
				projectPath: project.path
			})
			this.recentProjects.set(recentProjects ?? [])
			return
		}

		this.recentProjects.update(items => items.filter(item => item.path !== project.path))
	}

	protected openUrl(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer')
	}

	private async loadSponsors() {
		try {
			const response = await fetch('/sponsor/sponsor.json')
			if (!response.ok) return

			const data = (await response.json()) as Array<GuideSponsorItem>
			const shuffled = this.shuffleArray([...data])
			this.sponsors.set(shuffled)
			this.buildSponsorPages(shuffled)
			this.startSponsorCarousel()
		} catch {
			this.sponsors.set([])
			this.sponsorPages.set([])
			this.sponsorRenderPages.set([])
		}
	}

	private shuffleArray(array: Array<GuideSponsorItem>): Array<GuideSponsorItem> {
		const shuffled = [...array]
		for (let index = shuffled.length - 1; index > 0; index--) {
			const swapIndex = Math.floor(Math.random() * (index + 1))
			;[shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]]
		}
		return shuffled
	}

	private buildSponsorPages(sponsors: Array<GuideSponsorItem>) {
		const pages: Array<Array<GuideSponsorItem>> = []

		for (let index = 0; index < sponsors.length; index += this.sponsorPageSize) {
			const page = sponsors.slice(index, index + this.sponsorPageSize)
			let padIndex = 0
			while (page.length > 0 && page.length < this.sponsorPageSize) {
				page.push(sponsors[padIndex % sponsors.length])
				padIndex++
			}
			pages.push(page)
		}

		this.sponsorPages.set(pages)
		this.sponsorRenderPages.set(pages.length > 1 ? [...pages, pages[0]] : pages)
		this.sponsorPageIndex.set(0)
		this.sponsorPageTransitionEnabled.set(true)
	}

	private startSponsorCarousel() {
		this.stopSponsorCarousel()
		if (this.sponsorPages().length <= 1) return

		this.sponsorCarouselTimer = setTimeout(() => {
			this.advanceSponsorPage()
		}, this.sponsorPauseMs)
	}

	private stopSponsorCarousel() {
		if (this.sponsorCarouselTimer) {
			clearTimeout(this.sponsorCarouselTimer)
			this.sponsorCarouselTimer = null
		}

		if (this.sponsorResetTimer) {
			clearTimeout(this.sponsorResetTimer)
			this.sponsorResetTimer = null
		}
	}

	private advanceSponsorPage() {
		this.sponsorPageTransitionEnabled.set(true)
		this.sponsorPageIndex.update(index => index + 1)

		if (this.sponsorPageIndex() === this.sponsorPages().length) {
			this.sponsorResetTimer = setTimeout(() => {
				this.sponsorPageTransitionEnabled.set(false)
				this.sponsorPageIndex.set(0)

				this.sponsorResetTimer = setTimeout(() => {
					this.sponsorPageTransitionEnabled.set(true)
					this.sponsorResetTimer = null
				}, 50)
			}, this.sponsorTransitionMs)
		}

		this.sponsorCarouselTimer = setTimeout(() => {
			this.advanceSponsorPage()
		}, this.sponsorPauseMs + this.sponsorTransitionMs)
	}
}
