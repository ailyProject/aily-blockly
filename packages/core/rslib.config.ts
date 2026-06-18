import { deepmerge } from 'deepmerge-ts'

import { rslib } from '../../config'

import type { RslibConfig } from '@rslib/core'

export default deepmerge(rslib, {
	lib: [
		{
			source: { entry: { agent: './src/agent/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: {
				entry: {
					api: './src/api/index.ts',
					rpc: './src/rpc/index.ts',
					'rpc-standalone': './src/rpc/standalone.ts'
				}
			},
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { hardware: './src/hardware/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { project: './src/project/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { metadata: './src/metadata/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { document: './src/document/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { abi: './src/abi/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { abs: './src/abs/index.ts' } },
			format: 'esm',
			dts: true
		},
		{
			source: { entry: { build: './src/build/index.ts' } },
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
