import { Component, OnInit, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { getCore } from '@/utils/core'

import { guideCommunityLinks, guideQuickActions } from './data'

import type { GuideRecentProject } from './types'

@Component({
	selector: 'guide-page',
	imports: [HlmBadgeImports, HlmCardImports, RouterLink],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class GuidePageComponent implements OnInit {
	private readonly core = getCore()

	protected readonly quickActions = guideQuickActions
	protected readonly communityLinks = guideCommunityLinks
	protected readonly recentProjects = signal<Array<GuideRecentProject>>([])
	protected readonly language = signal('unknown')
	protected readonly onboardingCompleted = signal(false)

	async ngOnInit() {
		const [configSummary, recentProjects, onboarding] = await Promise.all([
			this.core.config.get.query({ fallbackLanguage: 'en_US' }),
			this.core.project.getRecentProjects.query({}),
			this.core.onboarding.getOnboarding.query({})
		])

		this.language.set(configSummary.selectedLanguage)
		this.recentProjects.set(recentProjects)
		this.onboardingCompleted.set(onboarding.onboardingCompleted)
	}
}
