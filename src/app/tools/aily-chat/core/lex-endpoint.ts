/**
 * Lightweight stateless LLM call utility using lex endpoints.
 *
 * Calls the model proxy through AilyServicesEndpoint. Custom credentials are
 * forwarded in model config so provider
 * protocol adaptation stays consistent with conversation requests.
 * Used by: ChatEngineService.generateTitle() and legacy stateless helper flows.
 */

import { Observable } from 'rxjs';
import { AilyHost } from './host';
import { createElectronAilyServicesTransport } from './aily-services-host-transport';

type AilyLexModule = typeof import('aily-lex/browser');

// Module singleton — shared with LexOwnerFacade (both lazy-load the same module).
let _lex: AilyLexModule | null = null;
let _loadPromise: Promise<AilyLexModule | null> | null = null;

async function getLexModule(): Promise<AilyLexModule | null> {
  if (_lex) return _lex;
  if (!_loadPromise) {
    _loadPromise = import('aily-lex/browser')
      .then(m => { _lex = m; return m; })
      .catch(() => { _loadPromise = null; return null; });
  }
  return _loadPromise;
}

function buildEndpoint(
  lex: AilyLexModule,
) {
  const apiEndpoint = AilyHost.get().config?.apiEndpoint || '';
  const hostTransport = createElectronAilyServicesTransport();
  return new lex.AilyServicesEndpoint({
    baseUrl: apiEndpoint,
    authTokenProvider: () => {
      const auth = AilyHost.get().auth;
      return auth?.getToken ? auth.getToken() : (auth?.token || '');
    },
    ...(hostTransport ? { transport: hostTransport } : {}),
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LexStatelessStreamOptions {
  modelId?: string;
  signal?: AbortSignal;
  llmConfig?: { apiKey: string; baseUrl: string } | null;
  requestContext?: {
    requestKind?: 'conversation' | 'utility';
    interactionTypeOverride?: 'conversation-background';
    userInitiatedRequest?: boolean;
  };
}

/**
 * Stateless LLM stream via lex endpoint.
 *
 * Emits `{ type: 'ModelClientStreamingChunkEvent', content }` events —
 * compatible with the existing stateless helper subscription pattern.
 */
export function lexStatelessStream(
  messages: any[],
  options?: LexStatelessStreamOptions,
): Observable<{ type: string; content?: string }> {
  return new Observable(observer => {
    const abortCtrl = new AbortController();
    const externalSignal = options?.signal;
    const onExternalAbort = () => abortCtrl.abort();
    if (externalSignal) {
      if (externalSignal.aborted) {
        abortCtrl.abort();
      } else {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    (async () => {
      try {
        const lex = await getLexModule();
        if (!lex) {
          observer.error(new Error('aily-lex module not available'));
          return;
        }

        const endpoint = buildEndpoint(lex);
        const config = {
          modelId: options?.modelId || 'default',
          maxOutputTokens: 4096,
          ...(options?.llmConfig ? { llmConfig: options.llmConfig } : {}),
        };
        const requestContext = options?.requestContext && (
          options.requestContext.requestKind
          || options.requestContext.interactionTypeOverride
          || typeof options.requestContext.userInitiatedRequest === 'boolean'
        )
          ? {
            ...(options.requestContext.requestKind ? { requestKind: options.requestContext.requestKind } : {}),
            ...(options.requestContext.interactionTypeOverride ? { interactionTypeOverride: options.requestContext.interactionTypeOverride } : {}),
            ...(typeof options.requestContext.userInitiatedRequest === 'boolean' ? { userInitiatedRequest: options.requestContext.userInitiatedRequest } : {}),
          }
          : undefined;

        for await (const chunk of endpoint.stream(messages, [], config, abortCtrl.signal, requestContext as any)) {
          if (abortCtrl.signal.aborted) return;
          if (chunk.type === 'text' && chunk.text) {
            observer.next({ type: 'ModelClientStreamingChunkEvent', content: chunk.text });
          }
        }
        if (!abortCtrl.signal.aborted) observer.complete();
      } catch (err) {
        if (!abortCtrl.signal.aborted) observer.error(err);
      }
    })();

    return () => {
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
      abortCtrl.abort();
    };
  });
}

// ---------------------------------------------------------------------------
// Title generation prompt (replicated from server /api/v1/generate_title)
// ---------------------------------------------------------------------------

const TITLE_GEN_PROMPT = `You are an expert in crafting ultra-compact titles for chatbot conversations.
You are presented with a chat request and must reply with only a brief title.

Rules:
1. Return title text only, no JSON, no markdown, no code fences
2. Use sentence case, preserve product names and code symbols
3. Aim for 3-6 words and keep it concise
4. Do not include quotes, prefixes, or trailing punctuation`;

function sanitizeTitleText(raw: string): string {
  let value = typeof raw === 'string' ? raw : '';
  if (!value.trim()) {
    return '';
  }

  // Drop hidden reasoning blocks emitted by some models.
  value = value.replace(/\s*<think>[\s\S]*?<\/think>\s*/gi, ' ').trim();

  // Accept JSON title shape if model still responds in legacy format.
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.title === 'string') {
      value = parsed.title;
    }
  } catch {
    // Keep plain-text path.
  }

  value = value
    .replace(/^```(?:json|text)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^\s*title\s*[:：]\s*/i, '')
    .replace(/^\s*["'“”‘’]|["'“”‘’]\s*$/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Reject assistant-style long prose to prevent title pollution.
  if (!value || value.length > 40) {
    return '';
  }

  if (/\b(当然|下面|我来|以下|可以|sorry|here is|let me|i can)\b/i.test(value)) {
    return '';
  }

  return value.replace(/[\s.?!。！？;；:：]+$/g, '').trim();
}

/**
 * Generate a concise title for the given user message content.
 * Calls LLM via lex endpoint, returns parsed title string.
 */
export async function lexGenerateTitle(
  content: string,
  options?: LexStatelessStreamOptions,
): Promise<string> {
  const titleContent = content.length > 500 ? content.substring(0, 500) : content;
  const messages = [
    { role: 'system', content: TITLE_GEN_PROMPT },
    { role: 'user', content: titleContent },
  ];

  return new Promise<string>((resolve, reject) => {
    let text = '';
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      sub.unsubscribe();
      if (settled) {
        return;
      }
      settled = true;
      resolve(sanitizeTitleText(text));
    }, 30000);

    const sub = lexStatelessStream(messages, options).subscribe({
      next: data => { if (data.content) text += data.content; },
      complete: () => {
        sub.unsubscribe();
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        resolve(sanitizeTitleText(text));
      },
      error: err => {
        sub.unsubscribe();
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        reject(err);
      },
    });
  });
}
