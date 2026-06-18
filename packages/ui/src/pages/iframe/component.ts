import { Component, computed, inject } from '@angular/core'
import { ActivatedRoute } from '@angular/router'
import { HlmCardImports } from 'spartan/card'

@Component({
	selector: 'iframe-page',
	imports: [HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class IframePageComponent {
	private readonly route = inject(ActivatedRoute)

	protected readonly targetUrl = computed(() => this.route.snapshot.queryParamMap.get('url') ?? 'about:blank')
}
