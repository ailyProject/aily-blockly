import { Component, computed, inject } from '@angular/core'
import { ActivatedRoute, RouterLink } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

@Component({
	selector: 'migration-page',
	imports: [HlmBadgeImports, HlmCardImports, RouterLink],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class MigrationPageComponent {
	private readonly route = inject(ActivatedRoute)

	protected readonly title = computed(() => String(this.route.snapshot.data['title'] ?? 'Migration Route'))
	protected readonly domain = computed(() => String(this.route.snapshot.data['domain'] ?? 'ui'))
	protected readonly summary = computed(() =>
		String(
			this.route.snapshot.data['summary'] ??
				'This route is wired and waiting for the corresponding UI domain migration.'
		)
	)
	protected readonly legacyHint = computed(() => String(this.route.snapshot.data['legacyHint'] ?? 'legacy route'))
}
