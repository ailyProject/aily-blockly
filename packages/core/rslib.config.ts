import path from 'node:path'
import { deepmerge } from 'deepmerge-ts'

import { rslib } from '../../config'

import type { RslibConfig } from '@rslib/core'

export default deepmerge(rslib, {
	lib: [
		{
			source: {
				entry: {
					index: './src/index.ts'
				}
			},
			format: 'esm',
			dts: true
		}
	],
	output: {
		copy: [
			{
				from: path.resolve('src/ffs/runtime/wasm/**/*.wasm'),
				context: path.resolve('src/ffs/runtime/wasm'),
				to: 'ffs/[path][name][ext]'
			}
		],
		filename: {
			js: '[name].js'
		}
	}
} as Partial<RslibConfig>)
