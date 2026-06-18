import { deepmerge } from 'deepmerge-ts'

import { rslib } from '../../config'

import type { RslibConfig } from '@rslib/core'

export default deepmerge(rslib, {
	lib: [
		{
			source: { entry: { agent: './agent/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: {
				entry: {
					api: './api/index.ts',
					rpc: './rpc/index.ts',
					'rpc-standalone': './rpc/standalone.ts'
				}
			},
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { hardware: './hardware/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { project: './project/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { metadata: './metadata/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { document: './document/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { abi: './abi/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { abs: './abs/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { build: './build/index.ts' } },
			format: 'esm',
			dts: true
		}
	],
	output: {
		filename: {
			js: '[name]/index.js'
		}
	}
} as Partial<RslibConfig>)
