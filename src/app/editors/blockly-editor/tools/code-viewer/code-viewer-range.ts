import type {
  BlockCodeMapping,
  CodeLineRange,
} from '../../components/blockly/generators/arduino/arduino';

/**
 * Pick the code range that should be brought into view for a selected block.
 *
 * A block can contribute support code (includes, objects, helper functions)
 * before its executable statement. Prefer the executable range so selecting
 * the block navigates to the statement users can see in setup/loop. Blocks
 * that only generate support code keep the existing first-range behaviour.
 */
export function resolveCodeViewerNavigationRange(
  mapping: Pick<BlockCodeMapping, 'lineRanges' | 'executableLineRanges'>,
): CodeLineRange | null {
  return mapping.executableLineRanges?.[0]
    ?? mapping.lineRanges[0]
    ?? null;
}

/** Collect every generated-code range for the currently selected blocks. */
export function resolveCodeViewerHighlightRanges(
  blockCodeMap: ReadonlyMap<string, BlockCodeMapping>,
  selectedBlockIds: ReadonlyArray<string>,
): CodeLineRange[] {
  return selectedBlockIds.flatMap((blockId) =>
    blockCodeMap.get(blockId)?.lineRanges ?? []
  );
}
