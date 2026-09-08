import { Injectable } from '@angular/core';
import { AuthService } from '@core/auth/public-api';
import { API } from '../../../configs/api.config';
import { beginCodeRequest } from './code-completion-request-gate';
import {
  SUGGESTION_REQUEST_CHANNEL, SUGGESTION_EVENT_CHANNEL, MAX_OUTPUT_BYTES,
  FEEDBACK_EVENTS, parseSuggestionRequest, SuggestionError, SuggestionSseDecoder,
  type SuggestionRequest,
} from './code-suggestion-protocol';

@Injectable()
export class CodeSuggestionHostBridgeService {
  private frame: Window | null = null;
  private disposed = false;
  private refresh: Promise<boolean> | null = null;
  private pending = new Map<string, AbortController>();
  private feedbackControllers = new Set<AbortController>();
  private readonly authSubscription: { unsubscribe(): void };
  constructor(private readonly auth: AuthService) {
    let identity: string | undefined;
    this.authSubscription = auth.userInfo$.subscribe(user => {
      const next = String(user?.id ?? user?.email ?? user?.login ?? user?.phone ?? '');
      if (identity !== undefined && identity !== next) {
        this.abortAll();
        if (this.frame) this.post(this.frame, 'auth-session', 'session-changed', {});
      }
      identity = next;
    });
  }

  registerFrame(frame: Window | null): void {
    if (frame === this.frame) return;
    this.abortAll();
    this.frame = frame;
  }
  dispose(): void { this.authSubscription.unsubscribe(); this.abortAll(); this.frame = null; this.disposed = true; }
  handleMessage(event: MessageEvent): boolean {
    const message = event.data;
    if (message?.channel !== SUGGESTION_REQUEST_CHANNEL) return false;
    const frame = this.frame;
    if (this.disposed || frame == null || event.source !== frame) return false;
    const id = message.requestId;
    if (typeof id !== 'string' || !/^[\w-]{8,128}$/.test(id)) return true;
    this.post(frame, id, 'ack', {});
    if (message.operation === 'cancel') { this.pending.get(id)?.abort(); return true; }
    if (message.operation === 'feedback') { this.sendFeedback(frame, message); return true; }
    if (!['capabilities', 'suggest'].includes(message.operation)) { this.error(frame, id, 400, 'INVALID_SUGGESTION_OPERATION'); return true; }
    let request: SuggestionRequest | undefined;
    if (message.operation === 'suggest') {
      try {
        request = parseSuggestionRequest(message.payload);
        if (id !== request.requestId) throw new SuggestionError('INVALID_SUGGESTION_ID');
      } catch (error) {
        this.error(frame, id, error instanceof SuggestionError ? error.status : 400, 'INVALID_SUGGESTION_REQUEST');
        return true;
      }
    }
    const controller = new AbortController();
    this.pending.get(id)?.abort();
    this.pending.set(id, controller);
    const release = request ? beginCodeRequest(frame, controller) : () => undefined;
    const timer = setTimeout(() => {
      this.error(frame, id, 504, 'CODE_SUGGESTION_TIMEOUT'); controller.abort();
    }, request ? 14_000 : 8_000);
    void this.run(frame, id, request, controller).catch(error => {
      if (!controller.signal.aborted) this.error(frame, id, error instanceof SuggestionError ? error.status : 502,
        error instanceof SuggestionError ? error.code : 'CODE_SUGGESTION_NETWORK_ERROR');
    }).finally(() => {
      clearTimeout(timer); release();
      if (this.pending.get(id) === controller) this.pending.delete(id);
    });
    return true;
  }
  private async run(frame: Window, id: string, request: SuggestionRequest | undefined, controller: AbortController): Promise<void> {
    const response = await this.authorized(request ? API.codeSuggestions : API.codeSuggestionCapabilities, {
      method: request ? 'POST' : 'GET',
      headers: { Accept: request ? 'text/event-stream' : 'application/json', 'Content-Type': 'application/json',
        'X-Request-ID': id, 'X-Aily-Client-Version': request?.client.version ?? 'coder-v4' },
      ...(request ? { body: JSON.stringify(request) } : {}), signal: controller.signal,
    });
    const headers: Record<string, string> = {};
    for (const key of ['retry-after', 'x-aily-completion-id', 'x-aily-completion-model', 'x-completion-quota-remaining', 'x-completion-quota-reset']) {
      const value = response.headers.get(key); if (value != null) headers[key] = value;
    }
    if (!response.ok) {
      await response.body?.cancel();
      this.error(frame, id, response.status, response.status === 404 || response.status === 405 ? 'CODE_SUGGESTION_UNSUPPORTED' : 'CODE_SUGGESTION_HTTP_ERROR', headers);
      return;
    }
    if (!request) {
      const text = await this.boundedText(response, MAX_OUTPUT_BYTES);
      const value = JSON.parse(text);
      if (!Array.isArray(value.protocolVersions) || !value.protocolVersions.includes(2) || !Array.isArray(value.modes)) throw new SuggestionError('INVALID_SUGGESTION_CAPABILITIES', undefined, 502);
      // Only expose the intersection, never endpoint details or extra server fields.
      this.post(frame, id, 'capabilities', { capabilities: {
        protocolVersions: [2], modes: value.modes.filter((mode: string) => ['completion', 'alternatives', 'next-edit'].includes(mode)),
        maxCandidates: Math.min(3, Number(value.maxCandidates) || 1), maxRequestBytes: Math.min(192 * 1024, Number(value.maxRequestBytes) || 0),
        maxOutputBytes: Math.min(MAX_OUTPUT_BYTES, Number(value.maxOutputBytes) || 0),
        features: { crossFile: false, atomicAdditionalEdits: value.features?.atomicAdditionalEdits === true,
          partialInsertAccept: value.features?.partialInsertAccept === true, partialAcceptWithImports: false, extendedRange: value.features?.extendedRange === true },
        quota: { enabled: value.quota?.enabled === true, allowed: value.quota?.allowed === true, remaining: Number(value.quota?.remaining ?? 0) },
        model: { id: typeof value.model?.id === 'string' ? value.model.id.slice(0, 64) : 'aily-code', selectable: false },
      } });
      return;
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new SuggestionError('INVALID_SUGGESTION_STREAM', undefined, 502);
    const reader = response.body.getReader();
    const utf8 = new TextDecoder('utf-8', { fatal: true });
    const decoder = new SuggestionSseDecoder(request);
    // Validate the entire result at the host boundary before exposing actionable output.
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (controller.signal.aborted || this.frame !== frame) return;
        decoder.push(utf8.decode(value, { stream: true }));
      }
      const tail = utf8.decode(); if (tail) decoder.push(tail);
      const result = decoder.finish();
      if (!controller.signal.aborted) this.post(frame, id, 'result', { result, headers });
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private async authorized(url: string, init: RequestInit): Promise<Response> {
    if (this.auth.isSessionInvalidating || init.signal?.aborted) throw new SuggestionError('SUGGESTION_UNAUTHORIZED', '请先登录。', 401);
    let token = (await this.auth.getToken2())?.trim();
    if (!token || init.signal?.aborted) throw new SuggestionError('SUGGESTION_UNAUTHORIZED', '请先登录。', 401);
    const fetchRequest = (value: string) => fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${value}` } });
    let response = await fetchRequest(token);
    if (response.status !== 401 || init.signal?.aborted) return response;
    await response.body?.cancel();
    this.refresh ??= this.auth.refreshAuthToken();
    let refreshed: boolean;
    try { refreshed = await this.refresh; } finally { this.refresh = null; }
    token = (await this.auth.getToken2())?.trim();
    if (!refreshed || !token || init.signal?.aborted || this.auth.isSessionInvalidating) throw new SuggestionError('SUGGESTION_UNAUTHORIZED', '请重新登录。', 401);
    response = await fetchRequest(token);
    return response;
  }
  private sendFeedback(frame: Window, message: Record<string, any>): void {
    const data = message['payload']; const completionId = message['completionId'];
    if (!/^sug_[a-f0-9]{32}$/.test(completionId) || !data || !new RegExp(`^${completionId}_[0-2]$`).test(data.candidateId) ||
      !/^[0-9a-f-]{36}$/i.test(data.opportunityId) || !FEEDBACK_EVENTS.includes(data.event) ||
      !Number.isInteger(data.acceptedCharacters ?? 0) || (data.acceptedCharacters ?? 0) < 0 || (data.acceptedCharacters ?? 0) > 65_536) return;
    const controller = new AbortController(); this.feedbackControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 5000);
    void this.authorized(`${API.codeSuggestions}/${completionId}/feedback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ opportunityId: data.opportunityId, candidateId: data.candidateId, event: data.event, acceptedCharacters: data.acceptedCharacters ?? 0 }),
    }).then(async response => {
      if (!response.ok && !controller.signal.aborted && this.frame === frame) this.post(frame, message['requestId'], 'feedback-error', { status: response.status });
      await response.body?.cancel();
    }).catch(() => undefined).finally(() => { clearTimeout(timer); this.feedbackControllers.delete(controller); });
  }
  private async boundedText(response: Response, maximum: number): Promise<string> {
    if (!response.body) throw new SuggestionError('EMPTY_SUGGESTION_RESPONSE');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let size = 0; let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length; if (size > maximum) throw new SuggestionError('SUGGESTION_TOO_LARGE');
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  private post(frame: Window, requestId: string, type: string, fields: object): void {
    if (!this.disposed && this.frame === frame) frame.postMessage({ channel: SUGGESTION_EVENT_CHANNEL, requestId, type, ...fields }, '*');
  }
  private error(frame: Window, id: string, status: number, code: string, headers: object = {}): void {
    this.post(frame, id, 'error', { status, code, headers });
  }
  private abortAll(): void {
    for (const controller of [...this.pending.values(), ...this.feedbackControllers]) controller.abort();
    this.pending.clear(); this.feedbackControllers.clear();
  }
}
