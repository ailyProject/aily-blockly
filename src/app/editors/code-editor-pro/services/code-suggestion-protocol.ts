/** Shared v4 wire contract. Keep the host copy byte-identical (contract test). */
export const SUGGESTION_REQUEST_CHANNEL = 'aily-coder-editor-code-suggestion-request'
export const SUGGESTION_EVENT_CHANNEL = 'aily-coder-editor-code-suggestion-event'
export const MAX_REQUEST_BYTES = 192 * 1024
export const MAX_OUTPUT_BYTES = 32 * 1024
export type Position = { line: number; character: number }
export type Range = { start: Position; end: Position }
export type DocumentRef = { fileId: string; snapshotId: string }
export type CodeWindow = { windowId: string; range: Range; text: string; purpose: 'completion' | 'context' | 'import'; allowedNewText?: string[] }
export type CandidateDocument = DocumentRef & {
  relativePath: string; languageId: string; version: number; permission: 'edit' | 'context-only'; windows: CodeWindow[]
}
export type RecentEdit = { fileId: string; before: string; after: string; ageMs: number; origin: 'typing' | 'paste' | 'completion' | 'undo' | 'redo' }
export type DiagnosticContext = DocumentRef & { range: Range; message: string; code?: string; severity: 'error' | 'warning'; freshness: 'version-matched' | 'observed-current' }
export type SuggestionRequest = {
  protocolVersion: 2; requestId: string; opportunityId: string; workspaceSessionId: string
  client: { name: 'aily-coder-editor'; version: string; sessionId: string }
  mode: 'completion' | 'alternatives' | 'next-edit'
  trigger: 'typing' | 'edit' | 'accept' | 'diagnostic' | 'manual'
  active: DocumentRef & { position: Position }
  documents: CandidateDocument[]; recentEdits: RecentEdit[]; diagnostics: DiagnosticContext[]
  options: { crossFile: false; autoImports: boolean; partialInsertAccept: boolean; maxCandidates: number }
}
export type TextEdit = { range: Range; expectedText: string; newText: string }
export type Suggestion = DocumentRef & { candidateId: string; kind: 'insert' | 'edit'; primary: TextEdit; additionalEdits: TextEdit[] }
export type SuggestionResult = {
  protocolVersion: 2; requestId: string; opportunityId: string; completionId: string
  suggestions: Suggestion[]; expiresInMs: number; finishReason: 'complete' | 'no-suggestion'
}
export const FEEDBACK_EVENTS = ['shown', 'partially_accepted', 'accepted', 'rejected', 'ignored', 'superseded', 'jump_shown', 'jumped', 'applied', 'stale', 'apply_failed', 'invalid_result'] as const
export type FeedbackEvent = typeof FEEDBACK_EVENTS[number]
export type SuggestionFeedback = { opportunityId: string; candidateId: string; event: FeedbackEvent; acceptedCharacters?: number }
export type SuggestionCapabilities = {
  protocolVersions: number[]; modes: SuggestionRequest['mode'][]; maxCandidates: number; maxRequestBytes: number; maxOutputBytes: number
  features: { crossFile: boolean; atomicAdditionalEdits: boolean; partialInsertAccept: boolean; partialAcceptWithImports: boolean; extendedRange: boolean }
  quota?: { enabled: boolean; allowed: boolean; remaining: number }
  model?: { id: string; selectable: boolean }
}
export class SuggestionError extends Error {
  constructor(readonly code: string, message = '编辑建议未通过校验。', readonly status = 400, readonly retryAfterMs = 0) { super(message) }
}
export function record(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw new SuggestionError('INVALID_SUGGESTION')
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new SuggestionError('INVALID_SUGGESTION_FIELDS')
}
function str(value: unknown, max: number, min = 0): asserts value is string {
  if (typeof value !== 'string' || value.length > max || value.length < min || value.includes('\0')) throw new SuggestionError('INVALID_SUGGESTION_TEXT')
}
function integer(value: unknown, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new SuggestionError('INVALID_SUGGESTION_NUMBER')
}
export const comparePosition = (a: Position, b: Position): number => a.line - b.line || a.character - b.character
export function validateRange(value: unknown): asserts value is Range {
  const range = record(value); keys(range, ['start', 'end'])
  for (const point of [range['start'], range['end']]) {
    const p = record(point); keys(p, ['line', 'character']); integer(p['line'], 10_000_000); integer(p['character'], 1_000_000)
  }
  if (comparePosition(range['start'] as Position, range['end'] as Position) > 0) throw new SuggestionError('INVALID_SUGGESTION_RANGE')
}
export const sameRange = (a: Range, b: Range): boolean => comparePosition(a.start, b.start) === 0 && comparePosition(a.end, b.end) === 0
export const wireBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length
export function parseSuggestionRequest(value: unknown): SuggestionRequest {
  if (wireBytes(value) > MAX_REQUEST_BYTES) throw new SuggestionError('SUGGESTION_TOO_LARGE', undefined, 413)
  const input = record(value)
  keys(input, ['protocolVersion', 'requestId', 'opportunityId', 'workspaceSessionId', 'client', 'mode', 'trigger', 'active', 'documents', 'recentEdits', 'diagnostics', 'options'])
  if (input['protocolVersion'] !== 2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(input['requestId'])) || input['requestId'] !== input['opportunityId']) throw new SuggestionError('INVALID_SUGGESTION_ID')
  str(input['workspaceSessionId'], 128, 8)
  const client = record(input['client']); keys(client, ['name', 'version', 'sessionId'])
  if (client['name'] !== 'aily-coder-editor') throw new SuggestionError('INVALID_SUGGESTION_CLIENT')
  str(client['version'], 64, 1); str(client['sessionId'], 128, 8)
  if (!['completion', 'alternatives', 'next-edit'].includes(String(input['mode'])) || !['typing', 'edit', 'accept', 'diagnostic', 'manual'].includes(String(input['trigger']))) throw new SuggestionError('INVALID_SUGGESTION_MODE')
  const options = record(input['options']); keys(options, ['crossFile', 'autoImports', 'partialInsertAccept', 'maxCandidates'])
  if (options['crossFile'] !== false || typeof options['autoImports'] !== 'boolean' || typeof options['partialInsertAccept'] !== 'boolean') throw new SuggestionError('INVALID_SUGGESTION_OPTIONS')
  integer(options['maxCandidates'], 3); if (options['maxCandidates'] === 0) throw new SuggestionError('INVALID_SUGGESTION_OPTIONS')
  const active = record(input['active']); keys(active, ['fileId', 'snapshotId', 'position']); str(active['fileId'], 64, 1); str(active['snapshotId'], 128, 1)
  validateRange({ start: active['position'], end: active['position'] })
  if (!Array.isArray(input['documents']) || input['documents'].length < 1 || input['documents'].length > 8) throw new SuggestionError('INVALID_SUGGESTION_DOCUMENTS')
  const files = new Map<string, CandidateDocument>(); const windowIds = new Set<string>()
  for (const item of input['documents']) {
    const doc = record(item); keys(doc, ['fileId', 'snapshotId', 'relativePath', 'languageId', 'version', 'permission', 'windows'])
    str(doc['fileId'], 64, 1); str(doc['snapshotId'], 128, 1); str(doc['relativePath'], 1024, 1); str(doc['languageId'], 64, 1); integer(doc['version'], Number.MAX_SAFE_INTEGER)
    if (/^(?:[\\/]|[a-z]:)/i.test(doc['relativePath']) || doc['relativePath'].replace(/\\/g, '/').split('/').includes('..') || files.has(doc['fileId'])) throw new SuggestionError('INVALID_SUGGESTION_DOCUMENT')
    if (!['edit', 'context-only'].includes(String(doc['permission'])) || (doc['permission'] === 'edit' && doc['fileId'] !== active['fileId'])) throw new SuggestionError('INVALID_SUGGESTION_PERMISSION')
    if (!Array.isArray(doc['windows']) || doc['windows'].length > 10) throw new SuggestionError('INVALID_SUGGESTION_WINDOWS')
    for (const item of doc['windows']) {
      const window = record(item); keys(window, ['windowId', 'range', 'text', 'purpose', 'allowedNewText'])
      str(window['windowId'], 64, 1); str(window['text'], 16_384); validateRange(window['range'])
      if (!/^[\w-]+$/.test(window['windowId']) || windowIds.has(window['windowId']) || !['completion', 'import', 'context'].includes(String(window['purpose']))) throw new SuggestionError('INVALID_SUGGESTION_WINDOW')
      windowIds.add(window['windowId'])
      const lines = window['text'].split('\n')
      if (window['range'].end.line !== window['range'].start.line + lines.length - 1 || window['range'].end.character !== lines.at(-1)!.length + (lines.length === 1 ? window['range'].start.character : 0)) throw new SuggestionError('INVALID_SUGGESTION_WINDOW_RANGE')
      if (window['allowedNewText'] != null && (!Array.isArray(window['allowedNewText']) || window['allowedNewText'].length > 4 || window['allowedNewText'].some(text => typeof text !== 'string' || text.length > 4096))) throw new SuggestionError('INVALID_SUGGESTION_IMPORT')
    }
    files.set(doc['fileId'], doc as unknown as CandidateDocument)
  }
  const activeDoc = files.get(active['fileId'])
  if (activeDoc?.snapshotId !== active['snapshotId'] || activeDoc.permission !== 'edit') throw new SuggestionError('INVALID_SUGGESTION_SNAPSHOT')
  if (input['mode'] !== 'next-edit' && !activeDoc.windows.some(w => w.purpose === 'completion' && sameRange(w.range, { start: active['position'] as Position, end: active['position'] as Position }))) throw new SuggestionError('INVALID_SUGGESTION_INSERT')
  if (!Array.isArray(input['recentEdits']) || input['recentEdits'].length > 20 || !Array.isArray(input['diagnostics']) || input['diagnostics'].length > 20) throw new SuggestionError('INVALID_SUGGESTION_CONTEXT')
  for (const item of input['recentEdits']) {
    const edit = record(item); keys(edit, ['fileId', 'before', 'after', 'ageMs', 'origin']); str(edit['before'], 4096); str(edit['after'], 4096); integer(edit['ageMs'], 300_000)
    if (!files.has(String(edit['fileId'])) || !['typing', 'paste', 'completion', 'undo', 'redo'].includes(String(edit['origin']))) throw new SuggestionError('INVALID_SUGGESTION_HISTORY')
  }
  for (const item of input['diagnostics']) {
    const diag = record(item); keys(diag, ['fileId', 'snapshotId', 'range', 'message', 'severity', 'code', 'freshness']); validateRange(diag['range']); str(diag['message'], 2048)
    if (diag['code'] != null) str(diag['code'], 128)
    if (files.get(String(diag['fileId']))?.snapshotId !== diag['snapshotId'] || !['error', 'warning'].includes(String(diag['severity'])) || !['version-matched', 'observed-current'].includes(String(diag['freshness']))) throw new SuggestionError('INVALID_SUGGESTION_DIAGNOSTIC')
  }
  return value as SuggestionRequest
}
export function validateSuggestionResult(value: unknown, request: SuggestionRequest): SuggestionResult {
  const result = record(value); keys(result, ['protocolVersion', 'requestId', 'opportunityId', 'completionId', 'suggestions', 'expiresInMs', 'finishReason'])
  if (wireBytes(value) > MAX_OUTPUT_BYTES || result['protocolVersion'] !== 2 || result['requestId'] !== request.requestId || result['opportunityId'] !== request.opportunityId || !/^sug_[a-f0-9]{32}$/.test(String(result['completionId']))) throw new SuggestionError('INVALID_SUGGESTION_ID')
  // Advanced comparison results intentionally live longer than automatic
  // inline suggestions so a user can review three candidates before applying.
  integer(result['expiresInMs'], 120_000)
  if (!Array.isArray(result['suggestions']) || result['suggestions'].length > request.options['maxCandidates'] || (request.mode === 'next-edit' && result['suggestions'].length > 1)) throw new SuggestionError('INVALID_SUGGESTION_COUNT')
  const ids = new Set<string>()
  for (const item of result['suggestions']) {
    const candidate = record(item); keys(candidate, ['candidateId', 'fileId', 'snapshotId', 'kind', 'primary', 'additionalEdits'])
    str(candidate['candidateId'], 64, 1)
    if (!new RegExp(`^${result['completionId']}_[0-2]$`).test(candidate['candidateId']) || ids.has(candidate['candidateId'])) throw new SuggestionError('INVALID_SUGGESTION_ID')
    ids.add(candidate['candidateId'])
    const doc = request.documents.find(d => d.fileId === candidate['fileId'] && d.snapshotId === candidate['snapshotId'] && d.permission === 'edit')
    if (doc == null || doc['fileId'] !== request.active['fileId'] || !['insert', 'edit'].includes(String(candidate['kind'])) || !Array.isArray(candidate['additionalEdits']) || candidate['additionalEdits'].length > 2) throw new SuggestionError('INVALID_SUGGESTION_TARGET')
    const edits = [candidate['primary'], ...candidate['additionalEdits']] as TextEdit[]
    for (let index = 0; index < edits.length; index++) {
      const edit = record(edits[index]); keys(edit, ['range', 'expectedText', 'newText']); validateRange(edit['range']); str(edit['expectedText'], 16_384); str(edit['newText'], 16_384)
      const window = doc['windows'].find(w => w.purpose === (index === 0 ? 'completion' : 'import') && sameRange(w.range, edit['range'] as Range) && w.text === edit['expectedText'])
      if (!window || edit['newText'] === edit['expectedText'] || (index > 0 && (!request.options['autoImports'] || !window['allowedNewText']?.includes(edit['newText'])))) throw new SuggestionError('INVALID_SUGGESTION_EDIT')
    }
    const primary = edits[0]!
    const empty = comparePosition(primary.range['start'], primary.range['end']) === 0
    if ((candidate['kind'] === 'insert') !== empty || (request.mode !== 'next-edit' && (!empty || comparePosition(primary.range['start'], request.active['position']) !== 0))) throw new SuggestionError('INVALID_SUGGESTION_KIND')
    const sorted = [...edits].sort((a, b) => comparePosition(a.range['start'], b.range['start']))
    for (let index = 1; index < sorted.length; index++) {
      if (comparePosition(sorted[index - 1]!.range['end'], sorted[index]!.range['start']) >= 0) throw new SuggestionError('OVERLAPPING_SUGGESTION_EDITS')
    }
  }
  if (result['finishReason'] !== (result['suggestions'].length ? 'complete' : 'no-suggestion')) throw new SuggestionError('INVALID_SUGGESTION_FINISH')
  return result as unknown as SuggestionResult
}
export class SuggestionSseDecoder {
  private buffer = ''
  private bytes = 0
  private meta?: string
  private done = false
  private result?: SuggestionResult
  constructor(private readonly request: SuggestionRequest) {}
  push(chunk: string): void {
    this.bytes += new TextEncoder().encode(chunk).length
    if (this.bytes > MAX_OUTPUT_BYTES + 8192) throw new SuggestionError('SUGGESTION_OUTPUT_TOO_LARGE')
    this.buffer += chunk
    for (let boundary = this.buffer.search(/\r?\n\r?\n/); boundary >= 0; boundary = this.buffer.search(/\r?\n\r?\n/)) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + (this.buffer.slice(boundary).startsWith('\r\n') ? 4 : 2))
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data) continue
      const event = record(JSON.parse(data))
      if (event['requestId'] !== this.request.requestId || event['opportunityId'] !== this.request.opportunityId || event['protocolVersion'] !== 2) throw new SuggestionError('INVALID_SUGGESTION_ID')
      if (this.done) throw new SuggestionError('SUGGESTION_AFTER_DONE')
      if (event['type'] === 'error') throw new SuggestionError(String(event['code'] || 'SUGGESTION_FAILED'), '编辑建议服务返回错误。', 502)
      if (event['type'] === 'meta') {
        if (this.meta) throw new SuggestionError('DUPLICATE_SUGGESTION_META')
        if (!/^sug_[a-f0-9]{32}$/.test(String(event['completionId']))) throw new SuggestionError('INVALID_SUGGESTION_ID')
        this.meta = String(event['completionId'])
      } else if (event['type'] === 'result') {
        if (!this.meta || this.result) throw new SuggestionError('INVALID_SUGGESTION_ORDER')
        if (event['completionId'] !== this.meta) throw new SuggestionError('INVALID_SUGGESTION_ID')
        const { type: _type, ...payload } = event
        this.result = validateSuggestionResult(payload, this.request)
      } else if (event['type'] === 'done') {
        if (!this.result || event['completionId'] !== this.result['completionId']) throw new SuggestionError('INVALID_SUGGESTION_FINISH')
        this.done = true
      } else throw new SuggestionError('UNKNOWN_SUGGESTION_EVENT')
    }
  }
  finish(): SuggestionResult {
    if (!this.done || !this.result || this.buffer.trim()) throw new SuggestionError('TRUNCATED_SUGGESTION_STREAM')
    return this.result
  }
}
