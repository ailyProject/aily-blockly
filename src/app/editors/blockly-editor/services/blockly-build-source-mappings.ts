import type * as Blockly from 'blockly';

import type { BlockCodeMapping } from '../components/blockly/generators/arduino/arduino';

export interface BlocklyBuildSourceMapping {
  readonly blockId: string;
  readonly executionRole: 'statement' | 'value';
  readonly ranges: ReadonlyArray<{ readonly startLine: number; readonly endLine: number }>;
  readonly executableRanges: ReadonlyArray<{ readonly startLine: number; readonly endLine: number }>;
  readonly supportRanges: ReadonlyArray<{ readonly startLine: number; readonly endLine: number }>;
}

/**
 * Freeze the generator's mutable block map while it still belongs to the exact
 * workspace that produced the sketch. The helper deliberately accepts a
 * detached workspace so Simulator builds never have to read the live editor.
 */
export function createBlocklyBuildSourceMappings(
  generatedCodeMap: ReadonlyMap<string, BlockCodeMapping>,
  generatedWorkspace: Pick<Blockly.Workspace, 'getBlockById'>,
): BlocklyBuildSourceMapping[] {
  return [...generatedCodeMap.values()]
    .map((mapping) => {
      const block = generatedWorkspace.getBlockById(mapping.blockId);
      return {
        blockId: mapping.blockId,
        executionRole: block?.outputConnection
          ? 'value' as const
          : 'statement' as const,
        ranges: normalizeBlockSourceRanges(mapping.lineRanges),
        executableRanges: normalizeBlockSourceRanges(
          mapping.executableLineRanges ?? mapping.lineRanges,
        ),
        supportRanges: normalizeBlockSourceRanges(
          mapping.supportLineRanges ?? [],
        ),
      };
    })
    .filter((mapping) => mapping.blockId.length > 0 && mapping.ranges.length > 0)
    .sort((left, right) => left.blockId.localeCompare(right.blockId));
}

function normalizeBlockSourceRanges(
  ranges: ReadonlyArray<{ startLine: number; endLine: number }>,
): Array<{ startLine: number; endLine: number }> {
  return ranges
    .filter((range) => (
      Number.isSafeInteger(range.startLine)
      && Number.isSafeInteger(range.endLine)
      && range.startLine >= 1
      && range.endLine >= range.startLine
    ))
    .map((range) => ({
      startLine: range.startLine,
      endLine: range.endLine,
    }))
    .sort((left, right) => (
      left.startLine - right.startLine
      || left.endLine - right.endLine
    ));
}
