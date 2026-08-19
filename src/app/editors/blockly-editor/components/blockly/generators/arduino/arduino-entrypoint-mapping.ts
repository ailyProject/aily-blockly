import type { BlockCodeMapping, CodeLineRange } from './arduino';

const ARDUINO_ENTRYPOINT_SIGNATURES: Readonly<Record<string, string>> = {
  arduino_setup: 'void setup() {',
  arduino_loop: 'void loop() {',
};

/**
 * Replace setup/loop container mappings with their complete generated function.
 *
 * Their generator calls addSetup/addLoop with all nested statement code, so
 * the generic fragment mapping initially attributes the whole body to the
 * container but omits the declaration and closing brace. The container itself
 * represents the full function; nested blocks keep their own precise mappings.
 */
export function applyArduinoEntrypointBlockMappings(
  finalCodeLines: ReadonlyArray<string>,
  blockTypes: ReadonlyMap<string, string>,
  blockCodeMap: Map<string, BlockCodeMapping>,
): void {
  const entrypointRanges = new Map<string, CodeLineRange>();

  for (const [blockType, signature] of Object.entries(ARDUINO_ENTRYPOINT_SIGNATURES)) {
    const lineRange = findFunctionLineRange(finalCodeLines, signature);
    if (lineRange) entrypointRanges.set(blockType, lineRange);
  }

  for (const [blockId, blockType] of blockTypes) {
    const lineRange = entrypointRanges.get(blockType);
    if (!lineRange) continue;

    const codeSnippet = finalCodeLines
      .slice(lineRange.startLine - 1, lineRange.endLine)
      .join('\n');
    blockCodeMap.set(blockId, {
      blockId,
      blockType,
      fragments: [{
        section: 'function_container',
        tag: blockId,
        code: codeSnippet,
      }],
      lineRanges: [{ ...lineRange }],
      executableLineRanges: [],
      supportLineRanges: [{ ...lineRange }],
      codeSnippet,
    });
  }
}

function findFunctionLineRange(
  finalCodeLines: ReadonlyArray<string>,
  signature: string,
): CodeLineRange | null {
  const startLineIndex = finalCodeLines.findIndex((line) => line.trim() === signature);
  if (startLineIndex < 0) return null;

  let braceDepth = 0;
  let hasOpeningBrace = false;
  let inBlockComment = false;
  let quotedWith: '"' | "'" | null = null;
  let escaped = false;

  for (let lineIndex = startLineIndex; lineIndex < finalCodeLines.length; lineIndex++) {
    const line = finalCodeLines[lineIndex];
    for (let columnIndex = 0; columnIndex < line.length; columnIndex++) {
      const character = line[columnIndex];
      const nextCharacter = line[columnIndex + 1];

      if (inBlockComment) {
        if (character === '*' && nextCharacter === '/') {
          inBlockComment = false;
          columnIndex++;
        }
        continue;
      }

      if (quotedWith) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === quotedWith) {
          quotedWith = null;
        }
        continue;
      }

      if (character === '/' && nextCharacter === '/') break;
      if (character === '/' && nextCharacter === '*') {
        inBlockComment = true;
        columnIndex++;
        continue;
      }
      if (character === '"' || character === "'") {
        quotedWith = character;
        continue;
      }
      if (character === '{') {
        hasOpeningBrace = true;
        braceDepth++;
        continue;
      }
      if (character === '}' && hasOpeningBrace) {
        braceDepth--;
        if (braceDepth === 0) {
          return {
            startLine: startLineIndex + 1,
            endLine: lineIndex + 1,
          };
        }
      }
    }

    // A line splice may continue a quoted literal, but the escape itself has
    // already been consumed and must not escape the first character next line.
    escaped = false;
  }

  return null;
}
