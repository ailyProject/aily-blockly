import type { LexStatelessStreamOptions } from '../core/lex-endpoint';
import { lexGenerateTitle } from '../core/lex-endpoint';
import { ChatAPI } from '../core/api-endpoints';
import { AilyHost } from '../core/host';

type TitleGenerator = (content: string, options?: LexStatelessStreamOptions) => Promise<string>;
type TitleLlmConfig = { apiKey: string; baseUrl: string };

export interface ChatTitleRequestOptions {
  signal?: AbortSignal;
}

export interface ChatTitleRequestProvider {
  generate(content: string, options?: ChatTitleRequestOptions): Promise<string>;
}

/**
 * Shapes title requests as a distinct utility/background call.
 */
export class ChatTitleRequestService implements ChatTitleRequestProvider {
  private static requestSequence = 0;

  constructor(
    private readonly getLlmConfig: () => TitleLlmConfig | null,
    private readonly generateTitleFn: TitleGenerator = lexGenerateTitle,
  ) {}

  async generate(content: string, options?: ChatTitleRequestOptions): Promise<string> {
    const requestId = `title-${++ChatTitleRequestService.requestSequence}`;
    const llmConfig = this.getLlmConfig();
    const normalizedContent = typeof content === 'string' ? content.trim() : '';
    console.info('[AilyChat][TitleRequest]', {
      requestId,
      event: 'request-received',
      hasCustomLlmConfig: !!llmConfig,
      contentLength: normalizedContent.length,
      abortedBeforeStart: options?.signal?.aborted === true,
    });

    // prefer dedicated title endpoint.
    // Only use direct generation when an explicit custom model is active.
    if (llmConfig) {
      console.info('[AilyChat][TitleRequest]', {
        requestId,
        event: 'path-selected',
        path: 'custom-llm',
        contentLength: normalizedContent.length,
        contentPreview: normalizedContent.slice(0, 120),
      });
      try {
        const title = await this.generateTitleFn(content, {
          modelId: 'auto',
          signal: options?.signal,
          requestContext: {
            requestKind: 'utility',
            interactionTypeOverride: 'conversation-background',
            userInitiatedRequest: false,
          },
          llmConfig,
        });
        const normalizedTitle = typeof title === 'string' ? title.trim() : '';
        console.info('[AilyChat][TitleRequest]', {
          requestId,
          event: 'path-result',
          path: 'custom-llm',
          resultLength: normalizedTitle.length,
          resultPreview: normalizedTitle.slice(0, 120),
        });

        if (normalizedTitle) {
          return normalizedTitle;
        }

        console.warn('[AilyChat][TitleRequest] custom-llm returned empty title, fallback to endpoint', {
          requestId,
        });
      } catch (error) {
        console.warn('[AilyChat][TitleRequest] custom-llm failed, fallback to endpoint', {
          requestId,
          error,
        });
      }
    }

    // Default path aligns to the dedicated title endpoint, which has server-side
    // model pool selection and strict extraction fallback.
    const token = await this.getAuthToken();
    console.info('[AilyChat][TitleRequest]', {
      requestId,
      event: 'path-selected',
      path: 'generate-title-endpoint',
      url: ChatAPI.generateTitle,
      hasAuthToken: !!token,
      contentLength: normalizedContent.length,
      contentPreview: normalizedContent.slice(0, 120),
    });
    try {
      const response = await fetch(ChatAPI.generateTitle, {
        method: 'POST',
        signal: options?.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        console.warn('[AilyChat][TitleRequest] request failed', {
          requestId,
          path: 'generate-title-endpoint',
          status: response.status,
        });

        const endpointError = new Error(`title request failed: ${response.status}`);
        if (response.status === 401 || response.status === 403) {
          const fallbackTitle = await this.tryLocalFallbackGeneration(content, options, requestId, {
            reason: `endpoint-auth-${response.status}`,
          });
          if (fallbackTitle) {
            return fallbackTitle;
          }
        }

        throw endpointError;
      }

      const payload = await response.json() as { data?: unknown };
      const title = typeof payload?.data === 'string' ? payload.data.trim() : '';
      console.info('[AilyChat][TitleRequest]', {
        requestId,
        event: 'path-result',
        path: 'generate-title-endpoint',
        status: response.status,
        resultLength: title.length,
        resultPreview: title.slice(0, 120),
      });
      return title;
    } catch (error) {
      if (this.isAbortError(error)) {
        throw error;
      }

      if (error instanceof Error && /^title request failed:\s*(401|403)$/.test(error.message)) {
        throw error;
      }

      const fallbackTitle = await this.tryLocalFallbackGeneration(content, options, requestId, {
        reason: 'endpoint-network-or-unknown',
      });
      if (fallbackTitle) {
        return fallbackTitle;
      }

      throw error;
    }
  }

  private async tryLocalFallbackGeneration(
    content: string,
    options: ChatTitleRequestOptions | undefined,
    requestId: string,
    diagnostics: { reason: string },
  ): Promise<string> {
    console.info('[AilyChat][TitleRequest]', {
      requestId,
      event: 'path-selected',
      path: 'local-fallback',
      reason: diagnostics.reason,
    });

    try {
      const title = await this.generateTitleFn(content, {
        modelId: 'auto',
        signal: options?.signal,
        requestContext: {
          requestKind: 'utility',
          interactionTypeOverride: 'conversation-background',
          userInitiatedRequest: false,
        },
      });
      const normalizedTitle = typeof title === 'string' ? title.trim() : '';
      console.info('[AilyChat][TitleRequest]', {
        requestId,
        event: 'path-result',
        path: 'local-fallback',
        resultLength: normalizedTitle.length,
        resultPreview: normalizedTitle.slice(0, 120),
      });
      return normalizedTitle;
    } catch (error) {
      if (this.isAbortError(error)) {
        throw error;
      }
      console.warn('[AilyChat][TitleRequest] local fallback failed', {
        requestId,
        reason: diagnostics.reason,
        error,
      });
      return '';
    }
  }

  private isAbortError(error: unknown): boolean {
    if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
      return error.name === 'AbortError';
    }
    return error instanceof Error && error.name === 'AbortError';
  }

  private async getAuthToken(): Promise<string> {
    const auth = AilyHost.get().auth;
    if (!auth) {
      return '';
    }
    if (typeof auth.getToken === 'function') {
      try {
        const token = await Promise.resolve(auth.getToken());
        return typeof token === 'string' ? token : '';
      } catch (error) {
        console.warn('[AilyChat][TitleRequest] failed to resolve auth token from getToken', error);
      }
    }
    return typeof auth.token === 'string' ? auth.token : '';
  }
}