#!/usr/bin/env bun
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createSerializer } from '@jlarky/gha-ts/render'
import { workflow } from '@jlarky/gha-ts/workflow-types'
import { YAML } from 'bun'

const workflow_definition = workflow({
	name: 'Release',
	on: {
		workflow_dispatch: {}
	},
	jobs: {
		prepare: {
			uses: './.github/workflows/prepare.generated.yml',
			secrets: 'inherit'
		},
		standalone: {
			needs: ['prepare'],
			uses: './.github/workflows/standalone.generated.yml',
			secrets: 'inherit'
		},
		desktop: {
			needs: ['prepare'],
			uses: './.github/workflows/desktop.generated.yml',
			secrets: 'inherit'
		}
	}
})

const current_dir = dirname(fileURLToPath(import.meta.url))
const output_path = resolve(current_dir, '../workflows/release.generated.yml')

createSerializer(workflow_definition, YAML.stringify).writeWorkflow(output_path)
