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

interface GuideNewsItem {
	slug: string
	title: string
	date: string
	url: string
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

	protected readonly recentProjects = signal<Array<GuideRecentProject>>([])
	protected readonly language = signal('zh_CN')
	protected readonly onboardingCompleted = signal(false)
	protected readonly runtimeInfo = signal<DesktopHostRuntimeInfo | null>(null)
	protected readonly newsPosts = signal<Array<GuideNewsItem>>([])
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
		const runtimeInfo = this.desktop ? await loadDesktopHostRuntimeInfo(this.desktop).catch(() => null) : null
		this.runtimeInfo.set(runtimeInfo)

		const configSummary = await this.core.config.get.query({ fallbackLanguage: 'zh_CN' }).catch(() => ({
			selectedLanguage: 'zh_CN'
		}))
		const onboarding = await this.core.onboarding.getOnboarding.query({}).catch(() => ({
			onboardingCompleted: false
		}))
		const recentProjects = runtimeInfo?.appDataPath
			? await this.core.project.getStoredRecentProjects.query({ appDataPath: runtimeInfo.appDataPath }).catch(() => [])
			: await this.core.project.getRecentProjects.query({}).catch(() => [])
		const nextRecentProjects =
			recentProjects.length > 0 ? recentProjects : await this.loadLegacyRecentProjectsFallback(runtimeInfo)

		this.language.set(configSummary.selectedLanguage)
		this.recentProjects.set(nextRecentProjects)
		this.onboardingCompleted.set(onboarding.onboardingCompleted)
		await this.loadNewsPosts()
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

	private async loadLegacyRecentProjectsFallback(
		runtimeInfo: DesktopHostRuntimeInfo | null
	): Promise<Array<GuideRecentProject>> {
		if (!runtimeInfo?.documentsPath) return []

		const userHome = runtimeInfo.documentsPath.replace(/\/Documents$/, '')
		const legacyAppDataPath = `${userHome}/Library/aily-project`
		return this.core.project.getStoredRecentProjects.query({ appDataPath: legacyAppDataPath }).catch(() => [])
	}

	private async loadNewsPosts() {
		try {
			const blogSupabaseUrl = 'https://tzhextxhguabwgfonuau.supabase.co'
			const blogSupabaseKey = 'sb_publishable_zVE3BAH9HKfscdtPQjEN0g_MHyoJz77'
			const tableName = this.isCnRegion() ? 'blog_posts' : 'blog_posts_en'
			const blogBaseUrl = this.isCnRegion() ? 'https://yiyu.pro' : 'https://aily.pro'
			const dateLocale = this.isCnRegion() ? 'zh-CN' : 'en-US'
			const url = new URL(`${blogSupabaseUrl}/rest/v1/${tableName}`)
			url.searchParams.set('select', 'slug,title,published_at,created_at')
			url.searchParams.set('is_published', 'eq.true')
			url.searchParams.set('order', 'published_at.desc')
			url.searchParams.set('limit', '10')

			const response = await fetch(url.toString(), {
				headers: {
					apikey: blogSupabaseKey,
					Authorization: `Bearer ${blogSupabaseKey}`
				}
			})
			if (!response.ok) return

			const posts = (await response.json()) as Array<{
				slug: string
				title?: string
				published_at?: string
				created_at?: string
			}>

			this.newsPosts.set(
				posts.map(post => ({
					slug: post.slug,
					title: post.title || post.slug,
					date: new Intl.DateTimeFormat(dateLocale, {
						year: 'numeric',
						month: 'numeric',
						day: 'numeric'
					}).format(new Date(post.published_at || post.created_at || Date.now())),
					url: `${blogBaseUrl}/blog/${encodeURIComponent(post.slug)}`
				}))
			)
		} catch {
			this.newsPosts.set([])
		}
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
