import { AilyHost } from '../core/host';

export interface ChatProcessWindowPayload {
  readonly sessionId: string;
  readonly processId: string;
  readonly outputSessionId?: string;
  readonly outputFilePath?: string;
  readonly command?: string;
  readonly windowTitle?: string;
}

export function buildChatProcessWindowPath(payload: ChatProcessWindowPayload): string {
  const sessionId = encodeURIComponent(payload.sessionId.trim());
  const processId = encodeURIComponent(payload.processId.trim());
  return `/aily-chat-process-detail/${sessionId}/${processId}`;
}

export function openChatProcessWindow(payload: ChatProcessWindowPayload): void {
  const normalizedSessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
  const normalizedProcessId = typeof payload.processId === 'string' ? payload.processId.trim() : '';
  if (!normalizedSessionId || !normalizedProcessId) {
    return;
  }

  window['subWindow']?.open?.({
    path: buildChatProcessWindowPath({
      ...payload,
      sessionId: normalizedSessionId,
      processId: normalizedProcessId,
    }),
    title: payload.windowTitle?.trim() || payload.command?.trim() || normalizedProcessId,
    width: 736,
    height: 540,
    data: {
      sessionId: normalizedSessionId,
      processId: normalizedProcessId,
      outputSessionId: payload.outputSessionId,
      outputFilePath: payload.outputFilePath,
      command: payload.command,
    },
  });
}

export function readChatProcessOutputFile(outputFilePath: string | undefined): string {
  const normalizedPath = typeof outputFilePath === 'string' ? outputFilePath.trim() : '';
  if (!normalizedPath) {
    return '';
  }

  try {
    const host = AilyHost.get();
    if (!host.fs?.existsSync?.(normalizedPath)) {
      return '';
    }
    return String(host.fs.readFileSync(normalizedPath, 'utf-8') ?? '');
  } catch {
    return '';
  }
}
