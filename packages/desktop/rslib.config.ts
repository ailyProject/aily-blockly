import { deepmerge } from 'deepmerge-ts'

import { rslib } from '../../config'

import type { RslibConfig } from '@rslib/core'

export default deepmerge(rslib, {
	lib: [
		{
			source: { entry: { main: './src/index.ts' } },
			format: 'cjs',
			dts: true,
			externals: ['electron'],
			tools: { rspack: { target: 'electron-main' } }
		},
		{
			source: { entry: { preload: './src/preload/index.ts' } },
			format: 'cjs',
			dts: true,
			externals: ['electron'],
			tools: { rspack: { target: 'electron-preload' } }
		}
	],
	output: {
		filename: {
			js: '[name]/index.js'
		}
	}
} as Partial<RslibConfig>)
