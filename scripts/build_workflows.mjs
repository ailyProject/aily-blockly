#!/usr/bin/env bun
import { readdirSync, statSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const current_dir = dirname(fileURLToPath(import.meta.url))
const root_dir = resolve(current_dir, '..')
const tsflow_dir = resolve(root_dir, '.github/tsflows')

const run = async () => {
	const entries = readdirSync(tsflow_dir)
		.filter(entry => entry.endsWith('.ts'))
		.map(entry => resolve(tsflow_dir, entry))
		.filter(file_path => statSync(file_path).isFile())
		.sort()

	if (entries.length === 0) {
		console.warn(`No tsflow sources found in ${tsflow_dir}`)
		return
	}

	for (const file_path of entries) {
		console.log(`Generating workflow from ${file_path}`)
		await import(file_path)
	}
}

await run()
