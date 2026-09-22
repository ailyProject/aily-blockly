import { scanAbsJsonTokens } from '@shared/public-api';
import { ProjectDataError } from './project-data.types';

/** Discover current raw JSON literals and legacy envelopes during the staged cutover. */
export function extractStructuredAbsValues(
  abs: string,
  options: { strict?: boolean } = {},
): unknown[] {
  const { tokens, errors } = scanAbsJsonTokens(abs);
  if (options.strict && errors.length) {
    throw new ProjectDataError('invalid-ref', errors[0].message);
  }
  const values: unknown[] = [];
  for (const token of tokens) {
    if (typeof token.value === 'string') {
      if (!token.value.startsWith('@json:')) continue;
      try {
        values.push(JSON.parse(token.value.slice(6)));
      } catch {
        if (options.strict) throw new ProjectDataError('invalid-ref', 'ABS contains malformed @json project data.');
      }
    } else values.push(token.value);
  }
  return values;
}
