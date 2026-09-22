import {
  assertNoOversizedInlineValues, externalizeGenericProjectDataValues,
  materializeGenericProjectDataValues, projectDataRuntime, canonicalJsonStringify,
  createAilyProjectDataValue, GenericProjectDataValueEntry,
} from '@domain/project/public-api';
import { scanAbsJsonTokens } from '@shared/public-api';
import { AbsSyncError } from './abs-state';
import { readAbsStatePath } from './abs-state-path';

export type AbsProjectDataPort = Pick<typeof projectDataRuntime, 'put' | 'resolve' | 'flushPending' | 'prepareValue'>;

/** Same asynchronous resource barrier for preview/export/import. Never touches Blockly or mirror files. */
export async function prepareAbsProjectData<T>(
  source: T, assertCurrent: () => void, runtime: AbsProjectDataPort = projectDataRuntime,
) {
  const checked = async <R>(operation: () => Promise<R>): Promise<R> => {
    assertCurrent();
    const result = await operation();
    assertCurrent();
    return result;
  };
  assertCurrent();
  const result = await externalizeGenericProjectDataValues(source, {
    put: request => checked(() => runtime.put(request)),
  });
  await checked(() => runtime.flushPending());
  assertNoOversizedInlineValues(result.document);
  // Preparation callbacks, callers and later native loaders must not share mutable proof.
  const documentText = JSON.stringify(result.document);
  const externalized = JSON.parse(JSON.stringify(result.externalized)) as typeof result.externalized;
  await checked(() => runtime.prepareValue(JSON.parse(documentText)));
  return {
    document: JSON.parse(documentText) as T, externalized,
    materialize: () => checked(() => materializeGenericProjectDataValues(JSON.parse(documentText) as T, {
      resolve: ref => checked(() => runtime.resolve(ref)),
    })),
  };
}

/** Legacy syntax has no serializer projection. Reject before load/write instead of losing state. */
export function assertLegacyAbsWorkspaceSupported(workspace: Record<string, unknown>): void {
  const unsupported = Object.keys(workspace).filter(key => !['blocks', 'variables', '$ailyProjectData'].includes(key));
  if (unsupported.length) throw new AbsSyncError('ABS_WORKSPACE_SERIALIZER_UNSUPPORTED',
    `当前 ABS 转换器无法保留工作区 serializer：${unsupported.join(', ')}。请使用 ABI/图形编辑，等待 v2 基线接线。`);
}

/** A v2 sidecar/baseline is mandatory; never interpret its source with the legacy converter. */
export function assertLegacyAbsSyntaxSupported(source: string): void {
  if (/^\s*#\s*ABS Schema\s*:/mu.test(source)) {
    throw new AbsSyncError('ABS_SCHEMA_UNSUPPORTED',
      '带 ABS Schema 版本的源文件需要对应的基线/map 同步入口；当前生产入口尚未启用 v2，未修改工作区。');
  }
}

/** Replace only prepared literals in named fields/@extra; retain comments, declarations and formatting. */
export function compactAbsProjectDataLiterals(
  abs: string, draft: unknown, entries: readonly GenericProjectDataValueEntry[],
): string {
  if (!entries.length) return abs;
  const fail = () => new AbsSyncError('ABS_DATA_LITERAL_REQUIRED',
    '无法可靠定位内联大值。请使用具名字段的双引号 JSON 字面量或 @extra JSON，原始 ABS 未修改。');
  const replacements = new Map<string, { value: unknown; required: number; used: number }>();
  for (const entry of entries) {
    const value = readAbsStatePath(draft, entry.jsonPointer);
    if (value === undefined) throw fail();
    const key = canonicalJsonStringify(value);
    const previous = replacements.get(key);
    if (previous) previous.required++;
    else replacements.set(key, { value: createAilyProjectDataValue(entry.ref), required: 1, used: 0 });
  }
  const { tokens, errors } = scanAbsJsonTokens(abs);
  if (errors.length) throw fail();
  const visit = (value: unknown): unknown => {
    const replacement = replacements.get(canonicalJsonStringify(value));
    if (replacement) { replacement.used++; return replacement.value; }
    if (!value || typeof value !== 'object') return value;
    for (const [key, member] of Object.entries(value)) {
      Object.defineProperty(value, key, { value: visit(member), enumerable: true, configurable: true, writable: true });
    }
    return value;
  };
  const edits: { start: number; end: number; value: string }[] = [];
  for (const token of tokens) {
    const lineStart = abs.lastIndexOf('\n', token.start - 1) + 1;
    if (abs.slice(lineStart, token.start).trimStart().startsWith('@var ')) continue;
    let previous = token.start - 1;
    while (previous >= 0 && /\s/u.test(abs[previous])) previous--;
    const extra = abs.slice(Math.max(0, previous - 6), previous + 1) === '@extra:';
    if (!extra && abs[previous] !== '=') continue;
    // @json is a legacy field transport, not a convention inside opaque JSON or @extra.
    const value = !extra && typeof token.value === 'string' && token.value.startsWith('@json:')
      ? JSON.parse(token.value.slice(6)) : token.value;
    const before = canonicalJsonStringify(value);
    const after = visit(value);
    if (canonicalJsonStringify(after) !== before) edits.push({ ...token, value: JSON.stringify(after) });
  }
  if ([...replacements.values()].some(entry => entry.used !== entry.required)) throw fail();
  const parts: string[] = [];
  let start = 0;
  for (const edit of edits) {
    parts.push(abs.slice(start, edit.start), edit.value);
    start = edit.end;
  }
  parts.push(abs.slice(start));
  return parts.join('');
}
