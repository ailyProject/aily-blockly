import { Component, computed, inject } from '@angular/core'
import { ActivatedRoute } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

@Component({
	selector: 'child-tool-page',
	imports: [HlmBadgeImports, HlmCardImports],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class ChildToolPageComponent {
	private readonly route = inject(ActivatedRoute)

	protected readonly toolId = computed(() => String(this.route.snapshot.paramMap.get('toolId') ?? 'unknown-tool'))
}
