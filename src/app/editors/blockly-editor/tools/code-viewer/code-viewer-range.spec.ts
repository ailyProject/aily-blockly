import type { BlockCodeMapping } from '../../components/blockly/generators/arduino/arduino';
import { normalizeCodeViewerSelectedBlockIds } from '../../services/code-viewer-ipc.service';
import {
  resolveCodeViewerHighlightRanges,
  resolveCodeViewerNavigationRange,
} from './code-viewer-range';

describe('resolveCodeViewerNavigationRange', () => {
  it('prefers the executable statement over earlier support code', () => {
    const mapping = createMapping({
      lineRanges: [
        { startLine: 3, endLine: 3 },
        { startLine: 5, endLine: 5 },
        { startLine: 9, endLine: 9 },
      ],
      executableLineRanges: [{ startLine: 9, endLine: 9 }],
      supportLineRanges: [
        { startLine: 3, endLine: 3 },
        { startLine: 5, endLine: 5 },
      ],
    });

    expect(resolveCodeViewerNavigationRange(mapping)).toEqual({
      startLine: 9,
      endLine: 9,
    });
  });

  it('falls back to the first mapped range for support-only blocks', () => {
    const mapping = createMapping({
      lineRanges: [{ startLine: 12, endLine: 14 }],
      executableLineRanges: [],
      supportLineRanges: [{ startLine: 12, endLine: 14 }],
    });

    expect(resolveCodeViewerNavigationRange(mapping)).toEqual({
      startLine: 12,
      endLine: 14,
    });
  });

  it('returns null when the block has no generated code range', () => {
    const mapping = createMapping({
      lineRanges: [],
      executableLineRanges: [],
      supportLineRanges: [],
    });

    expect(resolveCodeViewerNavigationRange(mapping)).toBeNull();
  });
});

describe('code viewer multi-selection', () => {
  it('keeps the primary block first and removes duplicate selected ids', () => {
    expect(normalizeCodeViewerSelectedBlockIds('second', ['first', 'second', 'third']))
      .toEqual(['second', 'first', 'third']);
  });

  it('falls back to the primary block for legacy single-selection state', () => {
    expect(normalizeCodeViewerSelectedBlockIds('only', undefined)).toEqual(['only']);
  });

  it('collects code ranges from every selected block', () => {
    const first = createMapping({
      blockId: 'first',
      lineRanges: [{ startLine: 4, endLine: 4 }],
    });
    const second = createMapping({
      blockId: 'second',
      lineRanges: [
        { startLine: 8, endLine: 8 },
        { startLine: 12, endLine: 13 },
      ],
    });

    expect(resolveCodeViewerHighlightRanges(
      new Map([
        [first.blockId, first],
        [second.blockId, second],
      ]),
      ['first', 'second'],
    )).toEqual([
      { startLine: 4, endLine: 4 },
      { startLine: 8, endLine: 8 },
      { startLine: 12, endLine: 13 },
    ]);
  });
});

function createMapping(
  overrides: Partial<BlockCodeMapping>,
): BlockCodeMapping {
  return {
    blockId: 'u8g2-begin',
    blockType: 'u8g2_begin',
    fragments: [],
    lineRanges: [],
    codeSnippet: '',
    ...overrides,
  };
}
