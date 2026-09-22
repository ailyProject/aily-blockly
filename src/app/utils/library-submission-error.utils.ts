import { TranslateService } from '@ngx-translate/core';
import { extractApiErrorDetails } from './api-error.utils';

export function getLibrarySubmissionErrorMessage(error: unknown, translate: Pick<TranslateService, 'instant'>): string {
  const details = extractApiErrorDetails(error);
  const status = error && typeof error === 'object' && typeof error['status'] === 'number'
    ? error['status'] as number
    : undefined;
  let message = details.message;
  // Angular transport messages and proxy HTML are not actionable error descriptions.
  if (!message || /^Http failure (response|during parsing)/i.test(message) || /^\s*<(?:!doctype|html)\b/i.test(message)) {
    const key = status === 0 ? 'NETWORK_ERROR' : status >= 500 ? 'SERVICE_ERROR' : 'UNKNOWN_ERROR';
    message = translate.instant(`LIBRARY_PUBLISH.${key}`);
  }

  const references: string[] = [];
  if (details.errorCode) {
    references.push(details.errorCode);
  } else if (status > 0) {
    references.push(`HTTP ${status}`);
  }
  const requestId = details.errorArgs['githubRequestId'];
  if (typeof requestId === 'string' && requestId.trim()) {
    references.push(`GitHub Request ID: ${requestId.trim()}`);
  }
  return references.length ? `${message} (${references.join('; ')})` : message;
}
