import { deepmerge } from 'deepmerge-ts'

import { rslib } from '../../config'

import type { RslibConfig } from '@rslib/core'

export default deepmerge(rslib, {
	lib: [
		{
			source: { entry: { index: './src/index.ts' } },
			format: 'esm',
			dts: true
		}
	],
	output: {
		filename: {
			js: '[name].js'
		}
	}
} as Partial<RslibConfig>)
