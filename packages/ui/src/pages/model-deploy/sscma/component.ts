import { Component } from '@angular/core'
import { RouterLink } from '@angular/router'
import { HlmBadgeImports } from 'spartan/badge'
import { HlmCardImports } from 'spartan/card'

import { modelCatalog } from '@/workspace'

import { deployChecks } from '../data'

@Component({
	selector: 'sscma-deploy-page',
	imports: [HlmBadgeImports, HlmCardImports, RouterLink],
	templateUrl: './component.html',
	styleUrl: './component.css'
})
export class SscmaDeployPageComponent {
	protected readonly checks = deployChecks
	protected readonly deployModels = modelCatalog.filter(item => item.deployTarget === 'sscma')
}
