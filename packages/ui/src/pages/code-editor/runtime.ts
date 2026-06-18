import { lintOutputSeed } from './data'

import type { Core } from '@/core-service'
import type { CodeEditorState } from './types'

export const loadCodeEditorState = async (core: Core): Promise<CodeEditorState> => {
	const abiPayload = {
		pages: [
			{
				title: 'Main',
				blocks: {
					blocks: [
						{
							type: 'controls_repeat_ext',
							id: 'repeat-1'
						}
					]
				}
			}
		]
	}

	const [lintResult, blockCount, stringified] = await Promise.all([
		core.build.parseArduinoLintResult.query({
			output: lintOutputSeed,
			startTime: Date.now() - 32,
			mode: 'fast',
			format: 'vscode'
		}),
		core.document.countAbiBlocks.query({ payload: abiPayload }),
		core.document.stringifyProjectAbi.query({ payload: abiPayload })
	])

	return {
		lintMode: lintResult.mode ?? 'fast',
		errorCount: lintResult.errors.length,
		warningCount: lintResult.warnings.length,
		executionTime: lintResult.executionTime,
		parsedBlockCount: blockCount,
		stringifiedLength: stringified.length
	}
}
