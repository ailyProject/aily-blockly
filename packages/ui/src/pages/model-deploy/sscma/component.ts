import { Component, OnInit, signal } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { injectCore } from '@/core-service'
import { loadModelCatalog } from '@/runtime/model-catalog'

import { deployChecks } from '../data'

import type { ModelCatalogItem } from 'shared'

@Component({
	selector: 'sscma-deploy-page',
	imports: [HlmBadgeImports, HlmCardImports, RouterLink],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SscmaDeployPageComponent implements OnInit {
	private readonly core = injectCore()

	protected readonly checks = deployChecks
	protected readonly deployModels = signal<Array<ModelCatalogItem>>([])

	async ngOnInit() {
		const result = await loadModelCatalog(this.core)
		this.deployModels.set(result.items.filter(item => item.deployTarget === 'sscma'))
	}
}
