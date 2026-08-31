/**
 * Extract structured @json field literals without parsing or resolving the
 * full ABS document. This keeps diagnostics/GC tolerant of an in-progress ABS
 * edit while still preserving every syntactically valid compact value.
 */
import { ProjectDataError } from './project-data.types';

export function extractStructuredAbsValues(
  abs: string,
  options: { strict?: boolean } = {},
): unknown[] {
  const values: unknown[] = [];
  const pattern = /"@json:((?:\\.|[^"\\])*)"/g;
  let matchedCount = 0;
  for (const match of abs.matchAll(pattern)) {
    matchedCount++;
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      values.push(JSON.parse(decoded));
    } catch (error) {
      if (options.strict) {
        throw new ProjectDataError('invalid-ref', 'ABS contains malformed @json project data.', {
          cause: String(error),
        });
      }
    }
  }
  const occurrenceCount = countUnescapedStructuredPrefixes(abs);
  if (options.strict && occurrenceCount !== matchedCount) {
    throw new ProjectDataError('invalid-ref', 'ABS contains an unterminated or malformed @json field value.');
  }
  return values;
}

function countUnescapedStructuredPrefixes(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '"' || !value.startsWith('@json:', index + 1)) continue;
    let precedingBackslashes = 0;
    for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor--) {
      precedingBackslashes++;
    }
    if (precedingBackslashes % 2 === 0) count++;
  }
  return count;
}
