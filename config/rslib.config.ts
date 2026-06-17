import type { RslibConfig } from '@rslib/core'

const is_dev = process.env.NODE_ENV === 'development'
const is_prod = process.env.NODE_ENV === 'production'
const postcss_plugins = ['postcss-import', 'postcss-nested', 'postcss-calc']

const prod_output = {} as RslibConfig['output']

if (is_prod) prod_output!['minify'] = {}

export default {
	mode: is_dev ? 'development' : 'production',
	source: { decorators: { version: 'legacy' } },
	output: {
		sourceMap: is_dev,
		injectStyles: true,
		cleanDistPath: is_prod,
		filename: { js: '[name]/index.js' },
		externals: ['react', 'react-dom'],
		...prod_output
	}
} as RslibConfig

export const tools = {
	lightningcssLoader: {
		targets: 'chrome >= 120',
		exclude: { isSelector: true }
	},
	postcss: () => {
		return {
			postcssOptions: {
				config: false,
				plugins: postcss_plugins.map(item => require(item))
			}
		}
	}
} as RslibConfig['tools']
