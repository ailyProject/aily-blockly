#!/usr/bin/env bun
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createSerializer } from '@jlarky/gha-ts/render'
import { workflow } from '@jlarky/gha-ts/workflow-types'
import { YAML } from 'bun'

const current_dir = dirname(fileURLToPath(import.meta.url))

const workflow_definition = workflow({
	name: 'Desktop Build',
	on: {
		workflow_dispatch: {}
	},
	jobs: {
		build: {
			if: "${{ github.ref == 'refs/heads/xwd-experimental' }}",
			'runs-on': 'macos-latest',
			steps: [
				{
					uses: 'actions/checkout@v6'
				},
				{
					uses: 'actions/setup-node@v6',
					with: {
						'node-version': 'lts/*'
					}
				},
				{
					uses: 'pnpm/action-setup@v6',
					with: {
						version: '11.7.0',
						run_install: false
					}
				},
				{
					name: 'Install dependencies',
					run: "printf '\\ntrustLockfile: true\\n' >> pnpm-workspace.yaml\npnpm install --frozen-lockfile"
				},
				{
					name: 'Build workspaces',
					run: [
						'pnpm --filter "./packages/erpc" run build',
						'pnpm --filter "./packages/shared" run build',
						'pnpm --filter "./packages/core" run build',
						'pnpm --filter "./packages/ui" run build',
						'pnpm --filter "./packages/desktop" run build'
					].join('\n')
				},
				{
					name: 'Package desktop',
					run: ['pnpm turbo run desktop#pack:mac', 'pnpm turbo run desktop#pack:win'].join('\n')
				}
			]
		}
	}
})

const output_path = resolve(current_dir, '../workflows/desktop.generated.yml')

createSerializer(workflow_definition, YAML.stringify).writeWorkflow(output_path)
