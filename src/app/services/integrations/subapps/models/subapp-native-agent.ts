import type { SubappOwnerGuard } from './subapp-owner-guard';

type NativeResponse = { ok: boolean; result?: unknown; error?: string; errorCode?: string; details?: unknown };
type NativeApi = (input: Record<string, unknown>) => Promise<NativeResponse>;
const fault = (code: string, message: string, details?: unknown) => Object.assign(new Error(message), { code, details });

/** Thin transport adapter. No sessions, Runtime discovery or process launching
 * here: those stay with the existing Agent owner and native batch supervisor. */
export async function invokeNativeSubappAgent(
  toolId: string, method: string, params: Record<string, unknown>, timeoutMs: number,
  ownerGuard: SubappOwnerGuard, ownerSessionId: string, signal?: AbortSignal, observer?: { sessionId: string },
): Promise<unknown> {
  if (toolId !== 'simulator-debugger' || !['runtime.capabilities', 'simdebug.run', 'simdebug.evidence.read'].includes(method)) {
    throw fault('SUBAPP_NATIVE_UNSUPPORTED', 'No native batch adapter is registered for this Subapp method.');
  }
  const api: NativeApi | undefined = (window as any).electronAPI?.childToolSession?.invokeNativeAgent;
  if (!api) throw fault('SUBAPP_HOST_UPDATE_REQUIRED', 'Update/restart the host to enable native Subapp Agent tools.');
  const check = () => { if (signal?.aborted) throw fault('SUBAPP_RPC_CANCELLED', 'Subapp Agent request was cancelled.'); };
  check();
  const owner = await ownerGuard.nativeOwner(ownerSessionId);
  check();
  const requestId = crypto.randomUUID();
  let cancelling: Promise<void> | undefined, cancellationError: unknown;
  const cancel = () => {
    cancelling ??= api({ action: 'cancel', toolId, requestId }).then(response => {
      if (!response.ok) throw fault(response.errorCode || 'SUBAPP_CANCEL_FAILED', response.error || 'Unable to cancel native batch.');
    }).catch(error => { cancellationError = error; });
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    // Send run before yielding. A subsequent cancel uses the same ordered IPC
    // channel; never race cancellation against an unregistered late launch.
    const response = await api({ action: 'call', toolId, method, params, requestId, owner, timeoutMs, ...(observer ? { observer } : {}) });
    await cancelling;
    if (!response.ok) throw fault(response.errorCode === 'CANCELLED' ? 'SUBAPP_RPC_CANCELLED' : response.errorCode || 'SUBAPP_RPC_FAILED', response.error || 'Native batch failed.', response.details);
    const report = response.result as { cleanup?: { failed?: boolean } } | undefined;
    if (report?.cleanup?.failed) throw fault('SUBAPP_CLEANUP_UNCONFIRMED', 'Native batch reported incomplete cleanup.', response.result);
    if (cancellationError) throw fault('SUBAPP_CLEANUP_UNCONFIRMED', 'Native cancellation could not be confirmed.', String(cancellationError));
    check();
    return response.result;
  } finally {
    signal?.removeEventListener('abort', cancel);
    await cancelling;
  }
}
