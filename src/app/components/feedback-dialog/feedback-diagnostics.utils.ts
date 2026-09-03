export const FEEDBACK_DIAGNOSTICS_MAX_BYTES = 32 * 1024;
export const FEEDBACK_CRASH_CONTEXT_MAX_BYTES = 16 * 1024;
export const FEEDBACK_TRUNCATION_MARKER = '[truncated; latest content retained]';

export type AccountStatusCode = '000' | '110' | '101' | '100' | null;

export interface DiagnosticLogSelection {
  content: string | null;
  latestTimestamp: number | null;
}

export interface DiagnosticTextBlock {
  key: string;
  kind: 'log' | 'result' | 'error';
  content: string | null;
  occurredAt?: number | null;
}

export interface CrashDiagnostic {
  reason: string | null;
  exitCode: number | null;
  processState: null;
  occurredAt: number | null;
  context: string;
}

interface RecentLogOptions {
  now: number;
  withinMs: number;
  limit: number;
  state?: string;
  query?: string;
}

const encoder = new TextEncoder();
const FEEDBACK_JSON_RETAIN_MAX_BYTES = FEEDBACK_DIAGNOSTICS_MAX_BYTES * 4;
const FEEDBACK_JSON_SCAN_MAX_BYTES = 1024 * 1024;
const REDACTED_DIAGNOSTIC_VALUE = '[REDACTED]';

export function resolveAccountStatusCode(
  initializationState: string | null | undefined,
  isAuthenticated: boolean,
  plan: unknown,
): AccountStatusCode {
  if (initializationState === 'signed_out') {
    return '000';
  }
  if (initializationState !== 'authenticated' || !isAuthenticated) {
    return null;
  }

  const normalizedPlan = typeof plan === 'string' ? plan.trim().toLowerCase() : '';
  if (normalizedPlan === 'free') {
    return '110';
  }
  if (normalizedPlan.includes('pro')) {
    return '101';
  }
  return '100';
}

export function selectRecentDiagnosticLogs(
  value: unknown,
  options: RecentLogOptions,
): DiagnosticLogSelection {
  if (!Array.isArray(value)) {
    return { content: null, latestTimestamp: null };
  }

  const query = options.query?.trim().toLowerCase() || '';
  const earliestTimestamp = options.now - options.withinMs;
  const selected = value
    .map((entry) => selectLogFields(entry))
    .filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .filter((entry) => (
      entry.timestamp >= earliestTimestamp
      && entry.timestamp <= options.now
      && (!options.state || entry.state === options.state)
      && (!query || `${entry.title}\n${entry.detail}`.toLowerCase().includes(query))
    ))
    .sort((left, right) => right.timestamp - left.timestamp)
    .slice(0, Math.max(0, options.limit))
    .sort((left, right) => left.timestamp - right.timestamp);

  if (selected.length === 0) {
    return { content: 'none', latestTimestamp: null };
  }

  return {
    content: selected.map(formatSelectedLog).join('\n'),
    latestTimestamp: selected[selected.length - 1].timestamp,
  };
}

export function sanitizeDiagnosticText(
  value: unknown,
  _pathHints: readonly string[] = [],
  maxBytes?: number,
  userHome?: string | null,
): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  let text = value.replace(/\u001b\[[0-9;]*m/g, '').replace(/\0/g, '');
  if (
    containsSerializedWorkspace(text)
    || containsExplicitSourcePayloadField(text)
    || containsUnseparablePrefixedPythonTraceback(text)
    || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(text)
  ) {
    return null;
  }

  text = redactDiagnosticJsonAndUserPaths(removeExplicitSourceExcerpts(text), userHome);

  const sanitized = text.trim();
  return maxBytes === undefined || utf8ByteLength(sanitized) <= maxBytes
    ? sanitized
    : truncateCompleteLineTail(sanitized.split(/\r\n|\n|\r/), maxBytes);
}

export function extractLatestCrashDiagnostic(
  value: string | readonly string[] | null | undefined,
  contextLineCount = 3,
): CrashDiagnostic | null {
  const lines = Array.isArray(value)
    ? [...value]
    : typeof value === 'string'
      ? value.split(/\r\n|\n|\r/)
      : [];

  let latest: { index: number; details: Record<string, unknown> } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes('[ProcessHealth][RendererGone]')) {
      const details = parseProcessHealthDetails(line);
      const reason = normalizeCrashReason(details['reason']);
      if (reason && reason !== 'clean-exit') {
        latest = { index, details };
      }
      continue;
    }
    if (!line.includes('[ProcessHealth][ChildGone]')) {
      continue;
    }
    const details = parseProcessHealthDetails(line);
    const reason = normalizeCrashReason(details['reason']);
    if (reason && reason !== 'clean-exit') {
      latest = { index, details };
    }
  }

  if (!latest) {
    return null;
  }

  const radius = Math.max(0, Math.floor(contextLineCount));
  const contextLines = lines.slice(
    Math.max(0, latest.index - radius),
    Math.min(lines.length, latest.index + radius + 1),
  );
  const rawExitCode = latest.details['exitCode'];

  return {
    reason: typeof latest.details['reason'] === 'string' && latest.details['reason'].trim()
      ? latest.details['reason'].trim()
      : null,
    exitCode: typeof rawExitCode === 'number' && Number.isFinite(rawExitCode) ? rawExitCode : null,
    processState: null,
    occurredAt: parseLogTimestamp(lines[latest.index]),
    context: contextLines.join('\n'),
  };
}

export function enforceDiagnosticTextBudget(
  blocks: readonly DiagnosticTextBlock[],
  maxBytes = FEEDBACK_DIAGNOSTICS_MAX_BYTES,
): DiagnosticTextBlock[] {
  const limited = blocks.map((block) => ({ ...block }));
  let overflow = totalBlockBytes(limited) - Math.max(0, maxBytes);
  if (overflow <= 0) {
    return limited;
  }

  const logs = limited
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.kind === 'log' && typeof block.content === 'string')
    .sort((left, right) => (
      (left.block.occurredAt ?? Number.NEGATIVE_INFINITY)
      - (right.block.occurredAt ?? Number.NEGATIVE_INFINITY)
      || left.index - right.index
    ));

  for (const { block } of logs.slice(0, -1)) {
    overflow = replaceWithTruncationMarker(block, overflow);
    if (overflow <= 0) {
      return limited;
    }
  }

  const newestLog = logs[logs.length - 1]?.block;
  if (newestLog) {
    overflow = truncateBlockByOverflow(newestLog, overflow);
  }

  for (const block of limited.filter((candidate) => candidate.kind !== 'log')) {
    if (overflow <= 0) {
      break;
    }
    overflow = truncateBlockByOverflow(block, overflow);
  }

  if (overflow > 0) {
    for (const block of limited) {
      if (overflow <= 0 || typeof block.content !== 'string') {
        continue;
      }
      const currentBytes = utf8ByteLength(block.content);
      block.content = '';
      overflow -= currentBytes;
    }
  }

  return limited;
}

export function truncateUtf8Tail(value: string, maxBytes: number): string {
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  if (utf8ByteLength(value) <= byteLimit) {
    return value;
  }
  if (byteLimit === 0) {
    return '';
  }

  const markerBytes = utf8ByteLength(FEEDBACK_TRUNCATION_MARKER);
  if (byteLimit <= markerBytes) {
    return FEEDBACK_TRUNCATION_MARKER.slice(0, byteLimit);
  }

  const tailLimit = byteLimit - markerBytes - 1;
  let tail = '';
  let tailBytes = 0;
  for (const character of Array.from(value).reverse()) {
    const characterBytes = utf8ByteLength(character);
    if (tailBytes + characterBytes > tailLimit) {
      break;
    }
    tail = character + tail;
    tailBytes += characterBytes;
  }
  return `${FEEDBACK_TRUNCATION_MARKER}\n${tail}`;
}

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function selectLogFields(value: unknown): {
  title: string;
  detail: string;
  state: string;
  timestamp: number;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;
  const timestamp = typeof entry['timestamp'] === 'number' ? entry['timestamp'] : Number.NaN;
  const title = typeof entry['title'] === 'string' ? entry['title'].trim() : '';
  const detail = typeof entry['detail'] === 'string' ? entry['detail'].trim() : '';
  if (!Number.isFinite(timestamp) || !Number.isFinite(new Date(timestamp).getTime()) || (!title && !detail)) {
    return null;
  }
  return {
    title,
    detail,
    state: typeof entry['state'] === 'string' ? entry['state'] : '',
    timestamp,
  };
}

function formatSelectedLog(entry: { title: string; detail: string; state: string; timestamp: number }): string {
  const message = [entry.title, entry.detail].filter(Boolean).join(': ');
  return `[${new Date(entry.timestamp).toISOString()}]${entry.state ? ` [${entry.state}]` : ''} ${message}`;
}

function containsSerializedWorkspace(value: string): boolean {
  return /<xml\b/i.test(value)
    || /(?:\\*["'])?blocks(?:\\*["'])?\s*:\s*(?:\[|\{)/i.test(value)
    || /\b(?:workspace|blocklyWorkspace|workspaceXml)\b(?:\\*["'])?\s*[:=]/i.test(value);
}

function containsExplicitSourcePayloadField(value: string): boolean {
  return /\b(?:lastBuildCode|sourceCode|generatedCode)\b(?:\\*["'])?\s*[:=]/i.test(value);
}

function containsUnseparablePrefixedPythonTraceback(value: string): boolean {
  return /^\[[^\]]+\](?:\s+\[[^\]]+\]){1,2}\s+File\s+["'][^"']+\.py["'],\s*line\s+\d+/im.test(value);
}

function redactDiagnosticJsonAndUserPaths(value: string, userHome?: string | null): string {
  if (utf8ByteLength(value) > FEEDBACK_JSON_SCAN_MAX_BYTES) {
    return FEEDBACK_TRUNCATION_MARKER;
  }

  const redacted = redactDiagnosticJsonFragments(value, userHome);
  return utf8ByteLength(redacted) > FEEDBACK_JSON_RETAIN_MAX_BYTES
    ? truncateCompleteLineTail(redacted.split(/\r\n|\n|\r/), FEEDBACK_JSON_RETAIN_MAX_BYTES)
    : redacted;
}

function redactDiagnosticJsonFragments(
  value: string,
  userHome?: string | null,
  depth = 0,
): string {
  let redacted = redactSensitiveJsonAssignments(value);
  if (depth < 32) {
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    for (const token of readJsonStringTokens(redacted)) {
      const nested = redactDiagnosticJsonFragments(token.decoded, userHome, depth + 1);
      if (nested !== token.decoded) {
        replacements.push({ start: token.start, end: token.end, value: JSON.stringify(nested) });
      }
    }
    redacted = applyTextReplacements(redacted, replacements);
  }
  return redactSupportedUserPaths(redactFreeTextSecrets(redacted), userHome);
}

function redactSensitiveJsonAssignments(value: string): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let coveredUntil = -1;
  for (const token of readJsonStringTokens(value)) {
    if (token.start < coveredUntil || !isSensitiveDiagnosticFieldName(token.decoded)) {
      continue;
    }
    let cursor = skipJsonWhitespace(value, token.end);
    if (value[cursor] !== ':') {
      continue;
    }
    cursor = skipJsonWhitespace(value, cursor + 1);
    const nextRecordStart = findNextDiagnosticRecordStart(value, cursor);
    const valueEnd = readJsonValueEnd(value, cursor, nextRecordStart);
    if (valueEnd === null) {
      const failureEnd = value[cursor] === '{' || value[cursor] === '['
        ? nextRecordStart
        : findLineEnd(value, cursor);
      replacements.push({
        start: cursor,
        end: failureEnd,
        value: JSON.stringify(REDACTED_DIAGNOSTIC_VALUE),
      });
      coveredUntil = failureEnd;
      continue;
    }
    replacements.push({
      start: cursor,
      end: valueEnd,
      value: JSON.stringify(REDACTED_DIAGNOSTIC_VALUE),
    });
    coveredUntil = valueEnd;
  }
  return applyTextReplacements(value, replacements);
}

function isSensitiveDiagnosticFieldName(value: string): boolean {
  const normalized = value.replace(/[\s_-]+/g, '').toLowerCase();
  return isExactSensitiveDiagnosticFieldName(normalized)
    || /(?:apikey|subscriptionkey|accesskey|accesskeyid|secretaccesskey|accountkey|accesstoken|refreshtoken|sessiontoken|idtoken|authtoken|token|password|passwd|credential|clientsecret|secret|secretkey|privatekey)s?$/.test(normalized);
}

function isExactSensitiveDiagnosticFieldName(normalized: string): boolean {
  return /^(?:authorization|cookie|setcookie|pnpid|serial|serialno|serialnumber|probeserial|useragent|userid|username|user|uid|accountid|accountname|account|owner|login|loginname|email|contact|contactinfo|phone|phonenumber|mobile|avatar|avatarurl|usernickname|wechatnickname|nickname|displayname|projectname|cloudid)s?$/.test(normalized)
    || /^(?:apikey|subscriptionkey|accesskey|accesskeyid|secretaccesskey|accountkey|accesstoken|refreshtoken|sessiontoken|idtoken|authtoken|token|password|passwd|credential|clientsecret|secret|secretkey|privatekey)s?$/.test(normalized);
}

function redactFreeTextSecrets(value: string): string {
  const redacted = value
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/g, '$1[REDACTED]@')
    .replace(
      /([?&](?:(?:x-amz|x-goog)[_-]?(?:credential|signature)|key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|auth|cookie|password|secret|signature|sig|code)=)[^&#\s"'\\}\]]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\bBearer\s+[^\s,;"'\\}\]]+/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED_DIAGNOSTIC_VALUE);
  return redactFreeTextAssignments(redacted);
}

function redactFreeTextAssignments(value: string): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  let coveredUntil = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (index < coveredUntil || (value[index] !== ':' && value[index] !== '=')) {
      continue;
    }
    if (!hasSensitiveFreeTextKey(value, index)) {
      continue;
    }
    const valueStart = skipInlineWhitespace(value, index + 1);
    const existingRedactionEnd = readExistingRedactionEnd(value, valueStart);
    if (existingRedactionEnd !== null) {
      index = existingRedactionEnd - 1;
      continue;
    }

    const quote = readFreeTextQuote(value, valueStart);
    const quotedValueEnd = quote ? readQuotedFreeTextValueEnd(value, quote) : null;
    const valueEnd = quotedValueEnd ?? findFreeTextValueEnd(value, valueStart);
    replacements.push({
      start: valueStart,
      end: valueEnd,
      value: quote && quotedValueEnd !== null
        ? `${quote.prefix}${quote.quote}${REDACTED_DIAGNOSTIC_VALUE}${quote.prefix}${quote.quote}`
        : REDACTED_DIAGNOSTIC_VALUE,
    });
    coveredUntil = valueEnd;
    index = valueEnd - 1;
  }
  return applyTextReplacements(value, replacements);
}

function hasSensitiveFreeTextKey(value: string, delimiterIndex: number): boolean {
  let keyEnd = delimiterIndex;
  while (keyEnd > 0 && /[ \t]/.test(value[keyEnd - 1])) {
    keyEnd -= 1;
  }
  if (value[keyEnd - 1] === '"' || value[keyEnd - 1] === "'") {
    keyEnd -= 1;
    while (keyEnd > 0 && value[keyEnd - 1] === '\\') {
      keyEnd -= 1;
    }
  }

  let keyStart = keyEnd;
  const earliestStart = Math.max(0, keyEnd - 128);
  while (keyStart > earliestStart && /[A-Za-z0-9_\- \t]/.test(value[keyStart - 1])) {
    keyStart -= 1;
  }
  if (keyStart > 0 && (value[keyStart - 1] === '/' || value[keyStart - 1] === '\\')) {
    return false;
  }
  const candidate = value.slice(keyStart, keyEnd);
  const candidateStarts = [0];
  for (let index = 0; index < candidate.length; index += 1) {
    if (/[\s_-]/.test(candidate[index])) {
      candidateStarts.push(index + 1);
    }
  }
  for (let index = candidateStarts.length - 1; index >= 0; index -= 1) {
    const suffix = candidate.slice(candidateStarts[index]).trim();
    const suffixStart = keyStart + candidateStarts[index];
    if (
      suffix
      && isSensitiveDiagnosticFieldName(suffix)
      && isAllowedFreeTextKeyCandidate(value, suffixStart, suffix, value[delimiterIndex])
    ) {
      return true;
    }
  }
  return false;
}

function isAllowedFreeTextKeyCandidate(
  value: string,
  start: number,
  candidate: string,
  delimiter: string,
): boolean {
  if (delimiter !== ':') {
    return true;
  }
  const normalized = candidate.replace(/[\s_-]+/g, '').toLowerCase();
  if (/\s/.test(candidate)) {
    return isExactSensitiveDiagnosticFieldName(normalized);
  }
  if (normalized !== 'token') {
    return true;
  }
  let previous = start - 1;
  while (previous >= 0 && /[ \t]/.test(value[previous])) {
    previous -= 1;
  }
  return previous < 0 || !/[A-Za-z0-9]/.test(value[previous]);
}

function readExistingRedactionEnd(value: string, start: number): number | null {
  const quote = readFreeTextQuote(value, start);
  if (quote) {
    const end = readQuotedFreeTextValueEnd(value, quote);
    return end !== null
      && value.slice(quote.contentStart, end - quote.prefix.length - 1) === REDACTED_DIAGNOSTIC_VALUE
      ? end
      : null;
  }
  const end = start + REDACTED_DIAGNOSTIC_VALUE.length;
  if (!value.startsWith(REDACTED_DIAGNOSTIC_VALUE, start)) {
    return null;
  }
  return end === value.length
    || /[\r\n,;}\]]/.test(value[end])
    || isFreeTextFieldBoundary(value, end)
    || /["']\s*[,}\]]/.test(value.slice(end, end + 8))
      ? end
      : null;
}

function readFreeTextQuote(
  value: string,
  start: number,
): { quote: string; prefix: string; contentStart: number } | null {
  let cursor = start;
  while (value[cursor] === '\\') {
    cursor += 1;
  }
  if (value[cursor] !== '"' && value[cursor] !== "'") {
    return null;
  }
  return {
    quote: value[cursor],
    prefix: value.slice(start, cursor),
    contentStart: cursor + 1,
  };
}

function readQuotedFreeTextValueEnd(
  value: string,
  opening: { quote: string; prefix: string; contentStart: number },
): number | null {
  for (let index = opening.contentStart; index < value.length; index += 1) {
    if (value[index] === '\r' || value[index] === '\n') {
      return null;
    }
    if (value[index] === opening.quote) {
      let backslashCount = 0;
      for (let cursor = index - 1; cursor >= opening.contentStart && value[cursor] === '\\'; cursor -= 1) {
        backslashCount += 1;
      }
      if (backslashCount === opening.prefix.length) {
        return index + 1;
      }
    }
  }
  return null;
}

function findFreeTextValueEnd(value: string, start: number): number {
  const lineEnd = findLineEnd(value, start);
  const remainder = value.slice(start, lineEnd);
  const fieldBoundary = remainder.search(
    /(?:[,;&]\s*|\s+)(?=(?:["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*[:=]))/,
  );
  const jsonBoundary = remainder.search(/(?=["']\s*[,}\]])/);
  const relativeEnd = [fieldBoundary, jsonBoundary]
    .filter((index) => index >= 0)
    .reduce((earliest, index) => Math.min(earliest, index), remainder.length);
  return start + relativeEnd;
}

function isFreeTextFieldBoundary(value: string, start: number): boolean {
  return /^(?:[,;&]\s*|\s+)(?=(?:["']?[A-Za-z_][A-Za-z0-9_.-]*["']?\s*[:=]))/.test(
    value.slice(start),
  );
}

function skipInlineWhitespace(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && /[ \t]/.test(value[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function readJsonStringTokens(value: string): Array<{ start: number; end: number; decoded: string }> {
  const tokens: Array<{ start: number; end: number; decoded: string }> = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '"') {
      continue;
    }
    const token = readJsonStringTokenAt(value, index);
    if (token) {
      tokens.push(token);
      index = token.end - 1;
    }
  }
  return tokens;
}

function readJsonStringTokenAt(
  value: string,
  start: number,
): { start: number; end: number; decoded: string } | null {
  if (value[start] !== '"') {
    return null;
  }
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') {
      const raw = value.slice(start, index + 1);
      try {
        const decoded: unknown = JSON.parse(raw);
        return typeof decoded === 'string' ? { start, end: index + 1, decoded } : null;
      } catch {
        return null;
      }
    }
    if (character === '\\') {
      index += 1;
      if (index >= value.length || !/["\\/bfnrtu]/.test(value[index])) {
        return null;
      }
      if (value[index] === 'u') {
        if (!/^[0-9a-f]{4}$/i.test(value.slice(index + 1, index + 5))) {
          return null;
        }
        index += 4;
      }
      continue;
    }
    if (character.charCodeAt(0) <= 0x1f) {
      return null;
    }
  }
  return null;
}

function readJsonValueEnd(value: string, start: number, end = value.length): number | null {
  const stringToken = readJsonStringTokenAt(value, start);
  if (stringToken && stringToken.end <= end) {
    return stringToken.end;
  }
  const opening = value[start];
  if (opening === '{' || opening === '[') {
    const closers = [opening === '{' ? '}' : ']'];
    for (let index = start + 1; index < end; index += 1) {
      if (value[index] === '"') {
        const token = readJsonStringTokenAt(value, index);
        if (!token) {
          return null;
        }
        index = token.end - 1;
      } else if (value[index] === '{' || value[index] === '[') {
        closers.push(value[index] === '{' ? '}' : ']');
      } else if (value[index] === '}' || value[index] === ']') {
        if (closers.pop() !== value[index]) {
          return null;
        }
        if (closers.length === 0) {
          return index + 1;
        }
      }
    }
    return null;
  }
  const primitive = value.slice(start, end).match(
    /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s*(?:[,}\]]|$))/,
  );
  return primitive ? start + primitive[0].length : null;
}

function findNextDiagnosticRecordStart(value: string, start: number): number {
  const match = value.slice(start).match(
    /\r?\n(?=\s*\[(?:\d{4}-\d{2}-\d{2}[^\]\r\n]*|TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)\](?:[ \t]+\[[^\]\r\n]+\])*(?:[ \t]+|$))/,
  );
  return match?.index === undefined ? value.length : start + match.index;
}

function skipJsonWhitespace(value: string, start: number): number {
  let cursor = start;
  while (cursor < value.length && /\s/.test(value[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function findLineEnd(value: string, start: number): number {
  const carriageReturn = value.indexOf('\r', start);
  const lineFeed = value.indexOf('\n', start);
  if (carriageReturn < 0) {
    return lineFeed < 0 ? value.length : lineFeed;
  }
  return lineFeed < 0 ? carriageReturn : Math.min(carriageReturn, lineFeed);
}

function applyTextReplacements(
  value: string,
  replacements: ReadonlyArray<{ start: number; end: number; value: string }>,
): string {
  let transformed = value;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index];
    transformed = `${transformed.slice(0, replacement.start)}${replacement.value}${transformed.slice(replacement.end)}`;
  }
  return transformed;
}

function redactSupportedUserPaths(value: string, userHome?: string | null): string {
  let redacted = redactEscapedUnicodeUserHomeSegments(value);
  redacted = redactExactUserHome(redacted, userHome);
  redacted = redacted
    .replace(
      /(^|[^A-Za-z0-9])([A-Za-z]:[\\/]+Users[\\/]+)([^\\/\r\n]+)(?=[\\/])/gi,
      '$1$2[USER]',
    )
    .replace(
      /(^|[^A-Za-z0-9])([A-Za-z]:[\\/]+Users[\\/]+)([^\\/\r\n"'<>?#{}|&\[\]),;:]+?)(?=["')\],;:?#<>{}|&]|$)/gim,
      '$1$2[USER]',
    )
    .replace(
      /(^|file:\/\/|[\s("'=:<>\[])(\/(?:home|Users)\/)([^/\r\n]+)(?=\/)/gi,
      '$1$2[USER]',
    )
    .replace(
      /(^|file:\/\/|[\s("'=:<>\[])(\/(?:home|Users)\/)([^/\r\n"'<>?#{}|&\[\]),;:]+?)(?=["')\],;:?#<>{}|&]|$)/gim,
      '$1$2[USER]',
    )
    .replace(
      /(^|[\s("'=:])~[^\\/\s"'<>?#{}|&,;:]+(?=[\\/]|["')\],;:\s?#<>{}|&]|$)/gim,
      '$1~[USER]',
    );
  return redacted;
}

function redactEscapedUnicodeUserHomeSegments(value: string): string {
  return value.replace(
    /([A-Za-z]:)(\\+)Users(\\+)([^/\r\n]+?)(?=\\+(?!\\|u[0-9a-f]{4})|["')\],;:\s?#<>{}|&]|$)/gi,
    (match, drive: string, rootSeparator: string, userSeparator: string, username: string) => (
      /\\+u[0-9a-f]{4}/i.test(username)
      || (userSeparator.length > rootSeparator.length && /^u[0-9a-f]{4}/i.test(username))
        ? `${drive}${rootSeparator}Users${rootSeparator}[USER]`
        : match
    ),
  ).replace(
    /((?:[A-Za-z]:\/+Users|\/(?:home|Users))\/+)([^/\r\n]+?)(?=\/|\\+(?=["'])|["')\],;:\s?#<>{}|&]|$)/gi,
    (match, root: string, username: string) => (
      /\\+u[0-9a-f]{4}/i.test(username) ? `${root}[USER]` : match
    ),
  );
}

function redactExactUserHome(value: string, userHome?: string | null): string {
  const trimmedHome = userHome?.trim().replace(/[\\/]+$/, '');
  if (!trimmedHome) {
    return value;
  }
  const homes = new Set([trimmedHome.normalize('NFC'), trimmedHome.normalize('NFD')]);
  let redacted = value;
  for (const home of homes) {
    const normalized = home.replace(/\\/g, '/');
    const segments = normalized.split('/');
    const username = segments.pop();
    if (!username || username === '.' || username === '..' || username === '[USER]') {
      continue;
    }
    const isWindowsHome = /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//');
    const leadingSeparator = normalized.startsWith('/') ? '[\\\\/]+' : isWindowsHome ? '[\\\\/]*' : '';
    const parentSegments = segments.filter(Boolean);
    const parentVariants = new Set([
      parentSegments.map(escapeRegExp).join('[\\\\/]+'),
      parentSegments.map((segment, index) => (
        index === 0 && /^[A-Za-z]:$/.test(segment)
          ? escapeRegExp(segment)
          : escapeUrlEncodedPathSegment(encodeURIComponent(segment))
      )).join('[\\\\/]+'),
    ]);
    const usernameAliases = new Set([
      escapeRegExp(username),
      escapeUrlEncodedPathSegment(encodeURIComponent(username)),
      escapeRegExp(jsonUnicodeEscape(username)),
    ]);
    for (const parent of parentVariants) {
      const parentPattern = `${leadingSeparator}${parent}[\\\\/]+`;
      for (const alias of usernameAliases) {
        redacted = redacted.replace(
          new RegExp(
            `(^|file:\\/\\/|[\\s("'=:<>\\[])(${parentPattern})${alias}(?=[\\\\/]+|["')\\],;:\\s?#<>{}|&]|$)`,
            isWindowsHome ? 'gi' : 'g',
          ),
          '$1$2[USER]',
        );
      }
    }
  }
  return redacted;
}

function jsonUnicodeEscape(value: string): string {
  return Array.from(value).map((character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      return character;
    }
    return JSON.stringify(character).slice(1, -1).replace(
      /[^\\]/g,
      (part) => `\\u${part.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  }).join('');
}

function escapeUrlEncodedPathSegment(value: string): string {
  return escapeRegExp(value).replace(
    /%([0-9a-f]{2})/gi,
    (_match, hex: string) => `%${Array.from(hex).map((character) => (
      /[a-f]/i.test(character)
        ? `[${character.toUpperCase()}${character.toLowerCase()}]`
        : character
    )).join('')}`,
  );
}

function truncateCompleteLineTail(lines: readonly string[], maxBytes: number): string {
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  const markerBytes = utf8ByteLength(FEEDBACK_TRUNCATION_MARKER);
  if (byteLimit <= markerBytes) {
    return FEEDBACK_TRUNCATION_MARKER.slice(0, byteLimit);
  }

  const retained: string[] = [];
  let retainedBytes = markerBytes;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const separatorBytes = 1;
    const lineBytes = utf8ByteLength(lines[index]);
    if (retainedBytes + separatorBytes + lineBytes > byteLimit) {
      break;
    }
    retained.unshift(lines[index]);
    retainedBytes += separatorBytes + lineBytes;
  }
  return retained.length > 0
    ? `${FEEDBACK_TRUNCATION_MARKER}\n${retained.join('\n')}`
    : FEEDBACK_TRUNCATION_MARKER;
}

function removeExplicitSourceExcerpts(value: string): string {
  const lines = value.split(/\r\n|\n|\r/);
  const retained: string[] = [];
  let compilerDiagnosticLinesRemaining = 0;
  let pythonSourceLinesRemaining = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const payload = stripProjectLogPrefix(line);
    if (/\b(?:lastBuildCode|sourceCode|generatedCode)\b["']?\s*[:=]/i.test(payload)) {
      continue;
    }
    if (/^\s*File\s+["'][^"']+\.py["'],\s*line\s+\d+/i.test(payload)) {
      pythonSourceLinesRemaining = 2;
      retained.push(line);
      continue;
    }
    if (pythonSourceLinesRemaining > 0) {
      if (/^\s+\S/.test(payload)) {
        pythonSourceLinesRemaining -= 1;
        continue;
      }
      pythonSourceLinesRemaining = 0;
    }
    if (/(?:\.ino|\.c|\.cc|\.cpp|\.cxx|\.h|\.hpp|\.s|\.asm|\.py|\.js|\.ts):\d+(?::\d+)?:/i.test(payload)) {
      compilerDiagnosticLinesRemaining = 3;
      retained.push(line);
      continue;
    }
    if (compilerDiagnosticLinesRemaining > 0) {
      const nextPayload = stripProjectLogPrefix(lines[index + 1] || '');
      if (/^\s*\d+\s*\|/.test(payload) || /^\s*\|?\s*[\^~]+/.test(payload)) {
        compilerDiagnosticLinesRemaining -= 1;
        continue;
      }
      if (/^\s*\|?\s*[\^~]+/.test(nextPayload)) {
        compilerDiagnosticLinesRemaining -= 1;
        continue;
      }
      compilerDiagnosticLinesRemaining -= 1;
    }
    retained.push(line);
  }

  return retained.join('\n');
}

function stripProjectLogPrefix(value: string): string {
  return value.replace(/^\[[^\]]+\](?:\s+\[[^\]]+\]){1,2}[ \t]?/, '');
}

function parseProcessHealthDetails(line: string): Record<string, unknown> {
  const jsonStart = line.indexOf('{');
  if (jsonStart < 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(line.slice(jsonStart));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function normalizeCrashReason(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function parseLogTimestamp(line: string): number | null {
  const match = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/);
  if (!match) {
    return null;
  }
  const timestamp = Date.parse(`${match[1]}T${match[2]}`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function replaceWithTruncationMarker(block: DiagnosticTextBlock, overflow: number): number {
  if (typeof block.content !== 'string') {
    return overflow;
  }
  const currentBytes = utf8ByteLength(block.content);
  const markerBytes = utf8ByteLength(FEEDBACK_TRUNCATION_MARKER);
  if (currentBytes <= markerBytes) {
    return overflow;
  }
  block.content = FEEDBACK_TRUNCATION_MARKER;
  return overflow - (currentBytes - markerBytes);
}

function truncateBlockByOverflow(block: DiagnosticTextBlock, overflow: number): number {
  if (typeof block.content !== 'string' || overflow <= 0) {
    return overflow;
  }
  const currentBytes = utf8ByteLength(block.content);
  const targetBytes = Math.max(utf8ByteLength(FEEDBACK_TRUNCATION_MARKER), currentBytes - overflow);
  block.content = truncateUtf8Tail(block.content, targetBytes);
  return overflow - (currentBytes - utf8ByteLength(block.content));
}

function totalBlockBytes(blocks: readonly DiagnosticTextBlock[]): number {
  return blocks.reduce(
    (total, block) => total + utf8ByteLength(typeof block.content === 'string' ? block.content : 'null'),
    0,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
