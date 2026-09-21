import { marked } from 'marked';
import { serializeAbsFailure } from './abs-diagnostics';
import { ABS_SCHEMA_HEADER } from './abs-state';
import { readAbsSyntax } from './abs-syntax';

/** Documentation syntax only: no workspace, model allocation, generation or persistence. */
export function checkAbsDocumentation(input: any) {
  if (input?.version !== 1 || !Array.isArray(input.documents) || input.documents.length > 2
    || !input.documents.length || input.documents.some((doc: any) =>
      !doc || !['README.md', 'README_AI.md'].includes(doc.name)
      || typeof doc.text !== 'string' || doc.text.length > 65536)
    || new Set(input.documents.map((doc: any) => doc.name)).size !== input.documents.length) {
    throw new Error('Expected version 1 and up to two distinct README documents (64 Ki characters each).');
  }
  const documents = input.documents.map((doc: { name: string; text: string }) => {
    const examples: any[] = [];
    marked.walkTokens(marked.lexer(doc.text), token => {
      if (token.type !== 'code' || token.lang?.trim().toLowerCase() !== 'abs') return;
      if (examples.length >= 64) throw new Error('Too many ABS examples (maximum 64 per document).');
      const body = token.text;
      // Snippets may omit the schema header; an explicit incompatible header is never replaced.
      const addedHeader = !/^\s*#\s*ABS Schema:/m.test(body);
      const source = addedHeader ? `${ABS_SCHEMA_HEADER}\n${body}` : body;
      const example = examples.length + 1;
      try {
        const nodes = readAbsSyntax(source);
        if (!nodes.length) throw new Error('An ABS example must contain at least one block call.');
        examples.push({ example, status: 'passed' });
      } catch (error) {
        const failure = serializeAbsFailure(error);
        const before = source.slice(0, failure.range?.start ?? 0).split('\n');
        examples.push({ example, status: 'failed', ...failure,
          location: { line: Math.max(1, before.length - Number(addedHeader)), column: before.at(-1)!.length + 1 } });
      }
    });
    return { name: doc.name, examples };
  });
  const count = documents.reduce((sum: number, doc: any) => sum + doc.examples.length, 0);
  return {
    version: 1, scope: 'abs-documentation-syntax',
    status: documents.some((doc: any) => doc.examples.some((example: any) => example.status === 'failed'))
      ? 'failed' : count ? 'passed' : 'no-examples',
    exampleCount: count, documents,
    notRun: ['block-bindings', 'native-generation', 'behavior-tests', 'hardware-measurements'],
  };
}
